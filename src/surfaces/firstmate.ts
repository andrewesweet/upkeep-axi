import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mapLimit, pathCandidates } from "../exec.js";
import type {
  ApplyDelegate,
  ExecResult,
  ForkSync,
  SemverTier,
  Surface,
  SurfaceContext,
  ToolStatus,
} from "../types.js";
import { applyCommandText, enrichWithConfig } from "./shared.js";

const SURFACE_ID = "firstmate";
const DEFAULT_CLONE_PATH = "/home/andre/tools/firstmate";
/** The one subject: the fork's clone tracks upstream and origin on main. */
const UPSTREAM_REMOTE = "upstream";
const FORK_REMOTE = "origin";
const DEFAULT_BRANCH = "main";
/** Fetching two small GitHub repositories over the network. */
const FETCH_TIMEOUT_MS = 120_000;
/** Local git plumbing: refs, counts, worktrees, the trial rebase. */
const GIT_LOCAL_TIMEOUT_MS = 30_000;

function clonePath(ctx: SurfaceContext): string {
  return ctx.surface.clonePath ?? DEFAULT_CLONE_PATH;
}

function gitPath(ctx: SurfaceContext): string | undefined {
  return pathCandidates("git", ctx.env)[0];
}

/** The tool's scratch root under its own state directory. */
export function forkSyncStateDir(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_STATE_HOME || join(env.HOME ?? homedir(), ".local/state");
  return join(xdg, "upkeep-axi", "firstmate-sync");
}

/** owner/name from a GitHub remote URL, or undefined when it is not one. */
export function parseGitHubSlug(url: string): string | undefined {
  const match = url.match(
    /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/,
  );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export function short(sha: string): string {
  return sha.slice(0, 7);
}

/** The tier the class carries: rebase (and its stopped case) is major, a pure fast-forward is minor. */
export function classTier(cls: ForkSync["class"]): SemverTier {
  switch (cls) {
    case "fast-forward":
      return "minor";
    case "clean-rebase":
    case "conflicts":
      return "major";
    case "current":
      return "none";
  }
}

/** One verbatim failing line from git, for the errors block. */
function failDetail(what: string, result: ExecResult): string {
  const cause =
    result.stderr.trim().split("\n")[0] ||
    result.spawnError ||
    `exit ${result.code}`;
  const how = result.timedOut
    ? "timed out"
    : result.spawnError
      ? "could not run"
      : `exit ${result.code}`;
  return `${what} failed (${how}): ${cause}`;
}

/** The branch a fast-forward sync pushes: named by the upstream commit it carries. */
export function fastForwardBranch(upstreamSha: string): string {
  return `sync/upstream-${short(upstreamSha)}`;
}

/** The branch a rebase sync pushes: named by the upstream commit it was built on. */
export function rebaseBranch(upstreamSha: string): string {
  return `sync/rebase-${short(upstreamSha)}`;
}

/**
 * The fast-forward sync: push upstream main to a new branch on the fork,
 * then open a plain pull request through gh. Two steps, `&&` semantics, no
 * rebase - the branch is upstream main verbatim, so fork CI reviews exactly
 * the upstream commits and the merge is a fast-forward.
 */
function fastForwardDelegate(
  ctx: SurfaceContext,
  clone: string,
  forkRepo: string,
  forkSha: string,
  upstreamSha: string,
): ApplyDelegate | undefined {
  const git = gitPath(ctx);
  const gh = pathCandidates("gh", ctx.env)[0];
  if (!git || !gh) return undefined;
  const branch = fastForwardBranch(upstreamSha);
  return {
    steps: [
      {
        file: git,
        args: [
          "-C",
          clone,
          "push",
          FORK_REMOTE,
          `${upstreamSha}:refs/heads/${branch}`,
        ],
      },
      {
        file: gh,
        args: [
          "pr",
          "create",
          "--repo",
          forkRepo,
          "--base",
          DEFAULT_BRANCH,
          "--head",
          branch,
          "--title",
          `Sync upstream main ${short(upstreamSha)} (pure fast-forward)`,
          "--body",
          `Pure upstream fast-forward: fork main (${short(forkSha)}) has no commits ahead of upstream main (${short(upstreamSha)}). This branch is upstream main verbatim; merging it fast-forwards the fork with no rewritten commits.`,
        ],
      },
    ],
  };
}

/**
 * The rebase sync: replay the fork's bespoke commits onto upstream main in
 * a scratch worktree under the tool's own state directory - never inside
 * the clone - push the rebased branch through the no-mistakes gate
 * initialised in the clone (which opens the pull request after review),
 * then discard the scratch. The branch name is the run's identity: the
 * gate's run is the one on `sync/rebase-<upstream sha>`. Four steps with
 * `&&` semantics: a rebase that conflicts stops before any push, reported
 * verbatim; a refused or interrupted run leaves the scratch for the next
 * crew task (its path is in the journal's command).
 */
function rebaseDelegate(
  ctx: SurfaceContext,
  clone: string,
  forkSha: string,
  upstreamSha: string,
): ApplyDelegate | undefined {
  const git = gitPath(ctx);
  if (!git) return undefined;
  const scratch = join(
    forkSyncStateDir(ctx.env),
    `apply-${short(upstreamSha)}`,
  );
  const branch = rebaseBranch(upstreamSha);
  return {
    steps: [
      {
        file: git,
        args: [
          "-C",
          clone,
          "worktree",
          "add",
          "--detach",
          scratch,
          forkSha,
        ],
      },
      { file: git, args: ["-C", scratch, "rebase", upstreamSha] },
      {
        file: git,
        args: [
          "-C",
          scratch,
          "push",
          "no-mistakes",
          `HEAD:refs/heads/${branch}`,
        ],
      },
      {
        file: git,
        args: [
          "-C",
          clone,
          "worktree",
          "remove",
          "--force",
          scratch,
        ],
      },
    ],
  };
}

/**
 * The trial rebase: in a unique scratch worktree under the tool's own state
 * directory (discarded afterwards, whatever the outcome), replay the fork's
 * bespoke commits onto upstream main. A clean replay classifies
 * clean-rebase; a stopped one classifies conflicts and names the files.
 */
async function trialRebase(
  ctx: SurfaceContext,
  git: string,
  clone: string,
  forkSha: string,
  upstreamSha: string,
  forkAhead: number,
  upstreamAhead: number,
): Promise<{ sync?: ForkSync; error?: string }> {
  const root = forkSyncStateDir(ctx.env);
  if (!existsSync(root)) {
    // The scratch root is the tool's own state directory; the trial is the
    // first thing that ever needs it.
    mkdirSync(root, { recursive: true });
  }
  const scratch = mkdtempSync(join(root, "trial-"));
  try {
    const add = await ctx.exec(
      git,
      [
        "-C",
        clone,
        "worktree",
        "add",
        "--detach",
        scratch,
        forkSha,
      ],
      GIT_LOCAL_TIMEOUT_MS,
    );
    if (add.code !== 0 || add.timedOut) {
      return {
        error: failDetail(`git worktree add (trial rebase in ${scratch})`, add),
      };
    }
    const rebase = await ctx.exec(
      git,
      ["-C", scratch, "rebase", upstreamSha],
      GIT_LOCAL_TIMEOUT_MS,
    );
    if (rebase.code === 0 && !rebase.timedOut) {
      return { sync: { class: "clean-rebase", forkAhead, upstreamAhead } };
    }
    const files = await ctx.exec(
      git,
      ["-C", scratch, "diff", "--name-only", "--diff-filter=U"],
      GIT_LOCAL_TIMEOUT_MS,
    );
    const conflicting = files.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      sync: {
        class: "conflicts",
        forkAhead,
        upstreamAhead,
        ...(conflicting.length > 0 ? { files: conflicting } : {}),
      },
    };
  } finally {
    // Discarded afterwards, whatever the outcome; the remove is best-effort
    // because a failed run must never mask the classification.
    await ctx.exec(
      git,
      ["-C", clone, "worktree", "remove", "--force", scratch],
      GIT_LOCAL_TIMEOUT_MS,
    );
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The Firstmate fork's sync with upstream: fetch both remotes, count the
 * commits each is ahead of the other, and classify by a trial rebase of the
 * fork's bespoke commits onto upstream main. The row's version is the fork
 * main commit, latest is upstream main, and the tier follows the class
 * (major for a rebase, minor for a pure fast-forward, none when current).
 * Nothing here touches the clone's working tree or any branch: fetches
 * update remote-tracking refs only, and the trial rebase runs in a scratch
 * worktree under the tool's own state directory, discarded afterwards.
 */
export const firstmateSurface: Surface = {
  id: SURFACE_ID,
  description: "the Firstmate fork's sync with upstream",
  managerTool: SURFACE_ID,

  async detect(ctx) {
    return gitPath(ctx) !== undefined;
  },

  async status(ctx) {
    const git = gitPath(ctx);
    if (!git) return [];
    const clone = clonePath(ctx);
    const probe = await ctx.exec(
      git,
      ["-C", clone, "rev-parse", "--git-dir"],
      GIT_LOCAL_TIMEOUT_MS,
    );
    if (probe.code !== 0 || probe.timedOut) {
      return enrichWithConfig(ctx, SURFACE_ID, [
        {
          surface: SURFACE_ID,
          tool: SURFACE_ID,
          installed: false,
        },
      ]);
    }

    const row: ToolStatus = {
      surface: SURFACE_ID,
      tool: SURFACE_ID,
      installed: true,
    };
    const errors: string[] = [];

    // The fork's GitHub identity, needed to open the fast-forward pull
    // request there. A fork remote that is not a GitHub URL is a fact, not
    // a probe failure: the class stands, the gate path still works, and
    // only the plain-gh pull request is unavailable.
    const url = await ctx.exec(
      git,
      ["-C", clone, "remote", "get-url", FORK_REMOTE],
      GIT_LOCAL_TIMEOUT_MS,
    );
    const forkRepo =
      url.code === 0 && !url.timedOut
        ? parseGitHubSlug(url.stdout.trim())
        : undefined;
    if (url.code !== 0 || url.timedOut) {
      errors.push(failDetail(`git remote get-url ${FORK_REMOTE}`, url));
    }

    // Fetch both remotes; remote-tracking refs are the only thing a fetch
    // writes. A failed fetch keeps the row and its surviving facts, and
    // leaves that side's ref unread: a classification from a stale ref
    // would be a guess.
    const remotes = [UPSTREAM_REMOTE, FORK_REMOTE];
    const fetched = await mapLimit(remotes, 2, (remote) =>
      ctx.exec(git, ["-C", clone, "fetch", remote], FETCH_TIMEOUT_MS),
    );
    const revParse = async (
      remote: string,
      fetch: ExecResult,
    ): Promise<string | undefined> => {
      if (fetch.code !== 0 || fetch.timedOut) {
        errors.push(failDetail(`git fetch ${remote}`, fetch));
        return undefined;
      }
      const ref = `refs/remotes/${remote}/${DEFAULT_BRANCH}`;
      const result = await ctx.exec(
        git,
        ["-C", clone, "rev-parse", ref],
        GIT_LOCAL_TIMEOUT_MS,
      );
      if (result.code !== 0 || result.timedOut) {
        errors.push(failDetail(`git rev-parse ${ref}`, result));
        return undefined;
      }
      return result.stdout.trim();
    };
    const [upstreamSha, forkSha] = await Promise.all([
      revParse(UPSTREAM_REMOTE, fetched[0]),
      revParse(FORK_REMOTE, fetched[1]),
    ]);
    if (forkSha) {
      row.version = forkSha;
      row.pinCommand = `git -C ${clone} push --force ${FORK_REMOTE} ${forkSha}:refs/heads/${DEFAULT_BRANCH}`;
    }
    if (!upstreamSha || !forkSha) {
      if (errors.length > 0) row.error = errors.join("; ");
      return enrichWithConfig(ctx, SURFACE_ID, [row]);
    }
    row.latest = upstreamSha;

    // Counts, then the class. Both zero, or fork ahead with nothing new
    // upstream, is current; nothing bespoke against a moved-upstream main
    // is a fast-forward; only a divergence needs the trial rebase.
    const [aheadOfUpstream, behindUpstream] = await Promise.all([
      ctx.exec(
        git,
        [
          "-C",
          clone,
          "rev-list",
          "--count",
          `${upstreamSha}..${forkSha}`,
        ],
        GIT_LOCAL_TIMEOUT_MS,
      ),
      ctx.exec(
        git,
        [
          "-C",
          clone,
          "rev-list",
          "--count",
          `${forkSha}..${upstreamSha}`,
        ],
        GIT_LOCAL_TIMEOUT_MS,
      ),
    ]);
    if (
      aheadOfUpstream.code !== 0 ||
      aheadOfUpstream.timedOut ||
      behindUpstream.code !== 0 ||
      behindUpstream.timedOut
    ) {
      const detail =
        aheadOfUpstream.code !== 0 || aheadOfUpstream.timedOut
          ? failDetail(
              "git rev-list --count (fork ahead of upstream)",
              aheadOfUpstream,
            )
          : failDetail(
              "git rev-list --count (upstream ahead of fork)",
              behindUpstream,
            );
      row.error =
        errors.length > 0 ? `${errors.join("; ")}; ${detail}` : detail;
      return enrichWithConfig(ctx, SURFACE_ID, [row]);
    }
    const forkAhead = Number.parseInt(aheadOfUpstream.stdout.trim(), 10);
    const upstreamAhead = Number.parseInt(behindUpstream.stdout.trim(), 10);

    let sync: ForkSync | undefined;
    if (forkAhead === 0 && upstreamAhead === 0) {
      sync = { class: "current", forkAhead, upstreamAhead };
    } else if (forkAhead === 0) {
      sync = { class: "fast-forward", forkAhead, upstreamAhead };
    } else if (upstreamAhead === 0) {
      sync = { class: "current", forkAhead, upstreamAhead };
    } else {
      const trial = await trialRebase(
        ctx,
        git,
        clone,
        forkSha,
        upstreamSha,
        forkAhead,
        upstreamAhead,
      );
      if (trial.error) errors.push(trial.error);
      sync = trial.sync;
    }

    if (sync) {
      row.sync = {
        ...sync,
        ...(forkRepo ? { forkRepo } : {}),
      };
      row.tier = classTier(sync.class);
      const delegate =
        sync.class === "fast-forward" && forkRepo
          ? fastForwardDelegate(ctx, clone, forkRepo, forkSha, upstreamSha)
          : sync.class === "clean-rebase"
            ? rebaseDelegate(ctx, clone, forkSha, upstreamSha)
            : undefined;
      if (delegate) row.applyCommand = applyCommandText(delegate);
      if (sync.class === "conflicts") {
        row.refusal = `the trial rebase conflicts${sync.files ? `: ${sync.files.join(", ")}` : ""}`;
      }
    }
    if (errors.length > 0) row.error = errors.join("; ");
    return enrichWithConfig(ctx, SURFACE_ID, [row]);
  },

  /**
   * The delegate is rebuilt from the same row facts status published, so
   * the plan's command text is exactly the status row's apply text. Only
   * fast-forward and clean-rebase rows have one; a conflicting sync refuses
   * through the row's refusal, and a current one has nothing to apply.
   */
  apply(ctx, row) {
    const sync = row.sync;
    const upstreamSha = row.latest;
    const forkSha = row.version;
    if (!row.installed || !sync || !upstreamSha || !forkSha) return undefined;
    const clone = clonePath(ctx);
    if (sync.class === "fast-forward") {
      if (!sync.forkRepo) return undefined;
      return fastForwardDelegate(
        ctx,
        clone,
        sync.forkRepo,
        forkSha,
        upstreamSha,
      );
    }
    if (sync.class === "clean-rebase") {
      return rebaseDelegate(ctx, clone, forkSha, upstreamSha);
    }
    return undefined;
  },

  /**
   * The apply pushes refs and opens a pull request; it replaces no
   * executable on this host, so the row is never in use.
   */
  replacedExecutables() {
    return [];
  },
};
