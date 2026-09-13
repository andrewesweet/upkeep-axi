import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEnv, runCli, type FakeEnv } from "./helpers.js";

/**
 * The real git executable, resolved once: fixture repositories are built
 * with it in the test process, and the fake `git` on the spawned CLI's PATH
 * forwards to it. The fake PATH never carries anything else, so the CLI can
 * reach no vendor binary but these fixtures.
 */
const REAL_GIT =
  spawnSync("/bin/sh", ["-c", "command -v git"], {
    encoding: "utf-8",
  }).stdout.trim() || "git";

type SyncClass =
  | "fast-forward"
  | "clean-rebase"
  | "conflicts"
  | "current"
  | "ahead";

interface ForkFixture {
  root: string;
  /** upstream.git, the upstream bare repository. */
  upstream: string;
  /** fork.git, the fork bare repository (the clone's origin). */
  fork: string;
  /** gate.git, a bare repository standing in for the no-mistakes gate. */
  gate: string;
  /** The local clone whose sync is reported. */
  clone: string;
  forkSha: string;
  upstreamSha: string;
}

/** Run real git in the test process, where failures fail loudly. */
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(REAL_GIT, args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${result.status}): ${result.stderr}`,
    );
  }
  return result.stdout;
}

function commitFile(
  repo: string,
  file: string,
  content: string,
  message: string,
): string {
  writeFileSync(join(repo, file), content);
  git(repo, "add", ".");
  git(
    repo,
    "-c",
    "user.email=fixture@example",
    "-c",
    "user.name=fixture",
    "commit",
    "-q",
    "-m",
    message,
  );
  return git(repo, "rev-parse", "HEAD").trim();
}

/**
 * Build the sync classes as real repositories in a temporary directory: an
 * upstream bare repo, a fork bare repo, a gate bare repo, and a working
 * clone with `origin` = fork and `upstream` = upstream. All remotes are
 * local paths, so no probe can touch the network.
 */
function buildFixture(kind: SyncClass): ForkFixture {
  const root = mkdtempSync(join(tmpdir(), "upkeep-axi-fmfork-"));
  const upstream = join(root, "upstream.git");
  const fork = join(root, "fork.git");
  const gate = join(root, "gate.git");
  for (const bare of [upstream, fork, gate]) {
    git(dirname(bare), "init", "--bare", "-q", "--initial-branch=main", bare);
  }
  // The gate echoes the words a no-mistakes push prints, so the applied
  // delegate's verbatim output is observable.
  const hook = join(gate, "hooks", "post-receive");
  writeFileSync(
    hook,
    "#!/bin/sh\necho 'no-mistakes: pipeline started'\nexit 0\n",
  );
  chmodSync(hook, 0o755);

  const work = join(root, "work");
  git(root, "clone", "-q", upstream, work);
  git(work, "checkout", "-q", "-b", "main");
  const base = commitFile(work, "shared.txt", "line one\nline two\n", "base");
  const pushToFork = () => git(work, "push", "-q", fork, "main");
  const pushToUpstream = () => git(work, "push", "-q", upstream, "main");

  let forkSha = base;
  let upstreamSha = base;
  switch (kind) {
    case "current": {
      // The fork equals upstream: nothing bespoke, nothing new.
      pushToUpstream();
      pushToFork();
      break;
    }
    case "ahead": {
      // The fork is ahead; upstream has nothing new.
      pushToUpstream();
      forkSha = commitFile(work, "bespoke.txt", "bespoke\n", "bespoke work");
      pushToFork();
      break;
    }
    case "fast-forward": {
      // Nothing bespoke; upstream main simply moved ahead.
      pushToFork();
      upstreamSha = commitFile(
        work,
        "upstream.txt",
        "new\n",
        "upstream advance",
      );
      pushToUpstream();
      break;
    }
    case "clean-rebase": {
      // Diverged, touching different files: the rebase replays cleanly.
      // The upstream advance is committed first, then the work repo is
      // rewound to base so the bespoke commit branches off it, not off the
      // advance.
      pushToUpstream();
      upstreamSha = commitFile(
        work,
        "upstream.txt",
        "new\n",
        "upstream advance",
      );
      pushToUpstream();
      git(work, "reset", "-q", "--hard", base);
      forkSha = commitFile(work, "bespoke.txt", "bespoke\n", "bespoke work");
      pushToFork();
      break;
    }
    case "conflicts": {
      // Diverged, editing the same lines: the trial rebase stops.
      pushToUpstream();
      upstreamSha = commitFile(
        work,
        "shared.txt",
        "upstream line\nline two\n",
        "upstream advance",
      );
      pushToUpstream();
      git(work, "reset", "-q", "--hard", base);
      forkSha = commitFile(
        work,
        "shared.txt",
        "bespoke line\nline two\n",
        "bespoke work",
      );
      pushToFork();
      break;
    }
  }

  const clone = join(root, "clone");
  git(root, "clone", "-q", fork, clone);
  git(clone, "remote", "add", "upstream", upstream);
  git(clone, "remote", "add", "no-mistakes", gate);
  // The scratch worktrees share the clone's config, so the replayed
  // commits carry an identity without touching global git config.
  git(clone, "config", "user.email", "fixture@example");
  git(clone, "config", "user.name", "fixture");
  return { root, upstream, fork, gate, clone, forkSha, upstreamSha };
}

/**
 * The spawned CLI's environment: a `git` shim that forwards to real git
 * (fixture remotes are local paths, so no probe reaches the network) but
 * answers `remote get-url origin` with the GitHub URL the real fork has,
 * and a `gh` fake that records `pr create` argv and answers with a URL.
 */
function firstmateEnv(fixture: ForkFixture): FakeEnv {
  const env = createEnv();
  env.writeFake(
    "git",
    `if [ "$3" = "remote" ] && [ "$4" = "get-url" ]; then
  echo "https://github.com/andrewesweet/firstmate.git"
  exit 0
fi
exec ${REAL_GIT} "$@"`,
  );
  env.writeFake(
    "gh",
    `if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  shift 2
  for a in "$@"; do echo "$a" >> "$HOME/gh-pr-calls"; done
  echo "https://github.com/andrewesweet/firstmate/pull/7"
  exit 0
fi
exit 1`,
  );
  env.writeConfig({
    surfaces: { firstmate: { clonePath: fixture.clone } },
  });
  return env;
}

interface StatusModel {
  schemaVersion: number;
  tools: Array<Record<string, unknown>>;
  sync?: Array<Record<string, unknown>>;
  errors?: Array<Record<string, unknown>>;
}

async function statusJson(env: FakeEnv): Promise<StatusModel> {
  const result = await runCli(
    ["status", "--surface", "firstmate", "--json"],
    env.env(),
  );
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as StatusModel;
}

async function applyJson(
  env: FakeEnv,
  args: string[],
): Promise<Record<string, unknown>> {
  const result = await runCli(
    ["apply", "firstmate", ...args, "--json"],
    env.env(),
  );
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("firstmate surface: status classes", () => {
  it("classifies a fork with nothing bespoke and a moved-upstream main as fast-forward", async () => {
    const fixture = buildFixture("fast-forward");
    const model = await statusJson(firstmateEnv(fixture));
    const row = model.tools.find((tool) => tool.tool === "firstmate");
    expect(row).toMatchObject({
      surface: "firstmate",
      installed: true,
      version: fixture.forkSha,
      latest: fixture.upstreamSha,
      tier: "minor",
      in_use: false,
    });
    expect(model.sync).toHaveLength(1);
    expect(model.sync?.[0]).toMatchObject({
      surface: "firstmate",
      tool: "firstmate",
      class: "fast-forward",
      fork_ahead: 0,
      upstream_ahead: 1,
      fork_repo: "andrewesweet/firstmate",
    });
    const apply = row?.apply as string;
    expect(apply).toContain(
      `push origin ${fixture.upstreamSha}:refs/heads/sync/upstream-${fixture.upstreamSha.slice(0, 7)}`,
    );
    expect(apply).toContain("gh pr create --repo andrewesweet/firstmate");
    expect(apply).toContain("Pure upstream fast-forward");
    // The pin names the fork main commit before the sync.
    expect(row?.pin).toBe(
      `git -C ${fixture.clone} push --force origin ${fixture.forkSha}:refs/heads/main`,
    );
  });

  it("classifies an equal fork as current with no apply command", async () => {
    const fixture = buildFixture("current");
    const model = await statusJson(firstmateEnv(fixture));
    const row = model.tools.find((tool) => tool.tool === "firstmate");
    expect(row).toMatchObject({
      installed: true,
      version: fixture.forkSha,
      latest: fixture.upstreamSha,
      tier: "none",
    });
    expect(row?.apply).toBeUndefined();
    expect(model.sync?.[0]).toMatchObject({
      class: "current",
      fork_ahead: 0,
      upstream_ahead: 0,
    });
  });

  it("classifies a fork ahead of an unchanged upstream as current", async () => {
    const fixture = buildFixture("ahead");
    const model = await statusJson(firstmateEnv(fixture));
    expect(model.sync?.[0]).toMatchObject({
      class: "current",
      fork_ahead: 1,
      upstream_ahead: 0,
    });
  });

  it("classifies diverged histories with a clean trial rebase as clean-rebase", async () => {
    const fixture = buildFixture("clean-rebase");
    const model = await statusJson(firstmateEnv(fixture));
    const row = model.tools.find((tool) => tool.tool === "firstmate");
    expect(model.sync?.[0]).toMatchObject({
      class: "clean-rebase",
      fork_ahead: 1,
      upstream_ahead: 1,
    });
    expect(row).toMatchObject({
      version: fixture.forkSha,
      latest: fixture.upstreamSha,
      tier: "major",
    });
    const apply = row?.apply as string;
    // The rebase runs in a scratch worktree, pushes through the no-mistakes
    // gate, and discards the scratch.
    expect(apply).toContain("worktree add --detach");
    expect(apply).toContain(`rebase ${fixture.upstreamSha}`);
    expect(apply).toContain(
      `push no-mistakes HEAD:refs/heads/sync/rebase-${fixture.upstreamSha.slice(0, 7)}`,
    );
    expect(apply).toContain("worktree remove --force");
    // The trial scratch is discarded: only the clone itself remains.
    expect(
      git(fixture.clone, "worktree", "list").trim().split("\n"),
    ).toHaveLength(1);
  });

  it("classifies a conflicting trial rebase as conflicts and lists the files", async () => {
    const fixture = buildFixture("conflicts");
    const model = await statusJson(firstmateEnv(fixture));
    expect(model.sync?.[0]).toMatchObject({
      class: "conflicts",
      fork_ahead: 1,
      upstream_ahead: 1,
      files: ["shared.txt"],
    });
    const row = model.tools.find((tool) => tool.tool === "firstmate");
    expect(row).toMatchObject({ tier: "major" });
    expect(row?.apply).toBeUndefined();
  });

  it("reports a missing clone as one not-installed row", async () => {
    const env = createEnv();
    env.writeFake("git", "exit 1");
    env.writeConfig({
      surfaces: { firstmate: { clonePath: "/nowhere/firstmate" } },
    });
    const model = await statusJson(env);
    expect(model.tools).toEqual([
      { surface: "firstmate", tool: "firstmate", installed: false },
    ]);
  });

  it("keeps the row with surviving facts and a verbatim error when a fetch fails", async () => {
    const fixture = buildFixture("fast-forward");
    git(
      fixture.clone,
      "remote",
      "set-url",
      "upstream",
      join(fixture.root, "missing.git"),
    );
    const model = await statusJson(firstmateEnv(fixture));
    const row = model.tools.find((tool) => tool.tool === "firstmate");
    expect(row).toMatchObject({ installed: true, version: fixture.forkSha });
    expect(row?.tier).toBeUndefined();
    expect(row?.apply).toBeUndefined();
    expect(model.errors?.[0]).toMatchObject({
      surface: "firstmate",
      tool: "firstmate",
    });
    expect(model.errors?.[0].detail).toContain("git fetch upstream failed");
    expect(model.sync).toBeUndefined();
  });

  it("rejects a malformed surface option as a usage error", async () => {
    const env = createEnv();
    env.writeFake("git", "exit 1");
    env.writeConfig({ surfaces: { firstmate: { clonePath: 42 } } });
    const result = await runCli(["status"], env.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "Config `surfaces.firstmate.clonePath` must be a non-empty string",
    );
  });

  it("answers in TOON with the sync block spelled like the JSON model", async () => {
    const fixture = buildFixture("fast-forward");
    const result = await runCli(
      ["status", "--surface", "firstmate"],
      firstmateEnv(fixture).env(),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "sync[1]{surface,tool,class,fork_ahead,upstream_ahead,fork_repo,files}:",
    );
    expect(result.stdout).toContain(
      "firstmate,firstmate,fast-forward,0,1,andrewesweet/firstmate",
    );
  });
});

describe("firstmate surface: apply", () => {
  it("plans the fast-forward push and pull request, and runs nothing without --execute", async () => {
    const fixture = buildFixture("fast-forward");
    const env = firstmateEnv(fixture);
    const report = await applyJson(env, []);
    const plan = report.plan as Array<Record<string, unknown>>;
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      surface: "firstmate",
      tool: "firstmate",
      before: fixture.forkSha,
      latest: fixture.upstreamSha,
      tier: "minor",
    });
    const command = plan[0].command as string;
    expect(command).toContain(`push origin ${fixture.upstreamSha}:`);
    expect(command).toContain("gh pr create");
    // Nothing ran: no sync branch on the fork, no gh call, no worktree.
    expect(git(fixture.fork, "for-each-ref", "refs/heads/sync")).toBe("");
    expect(existsSync(join(env.root, "gh-pr-calls"))).toBe(false);
    expect(
      git(fixture.clone, "worktree", "list").trim().split("\n"),
    ).toHaveLength(1);
  });

  it("executes the fast-forward: pushes upstream main as a branch and opens a plain pull request", async () => {
    const fixture = buildFixture("fast-forward");
    const env = firstmateEnv(fixture);
    const report = await applyJson(env, ["--execute"]);
    const results = report.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      surface: "firstmate",
      outcome: "applied",
      exit: 0,
      before: fixture.forkSha,
      // The pull request does not move fork main; the record says so.
      after: fixture.forkSha,
    });
    // The fork carries the branch: upstream main, verbatim.
    const branch = `refs/heads/sync/upstream-${fixture.upstreamSha.slice(0, 7)}`;
    expect(git(fixture.fork, "rev-parse", branch).trim()).toBe(
      fixture.upstreamSha,
    );
    // gh saw the plain pull request with the fast-forward body.
    const calls = readFileSync(join(env.root, "gh-pr-calls"), "utf-8");
    expect(calls).toContain("andrewesweet/firstmate");
    expect(calls).toContain(`sync/upstream-${fixture.upstreamSha.slice(0, 7)}`);
    expect(calls).toContain("Pure upstream fast-forward");
    // The journal records the outcome, with the pin.
    const journalResult = await runCli(["journal", "--json"], env.env());
    const records = (
      JSON.parse(journalResult.stdout) as {
        records: Array<Record<string, unknown>>;
      }
    ).records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      surface: "firstmate",
      tool: "firstmate",
      before: fixture.forkSha,
      after: fixture.forkSha,
      tier: "minor",
      exit: 0,
      pin: `git -C ${fixture.clone} push --force origin ${fixture.forkSha}:refs/heads/main`,
    });
    // gh's own words - the pull request URL - are reported verbatim.
    const output = report.output as Array<Record<string, string>>;
    expect(output.some((row) => row.detail.includes("pull/7"))).toBe(true);
  });

  it("executes the clean rebase: pushes the rebased branch through the gate and discards the scratch", async () => {
    const fixture = buildFixture("clean-rebase");
    const env = firstmateEnv(fixture);
    const report = await applyJson(env, ["--execute"]);
    const results = report.results as Array<Record<string, unknown>>;
    expect(results[0]).toMatchObject({ outcome: "applied", exit: 0 });
    // The gate carries the rebased branch: the bespoke commit replayed onto
    // upstream main.
    const branch = `refs/heads/sync/rebase-${fixture.upstreamSha.slice(0, 7)}`;
    const tip = git(fixture.gate, "rev-parse", branch).trim();
    expect(git(fixture.gate, "log", "--format=%s", "-1", tip).trim()).toBe(
      "bespoke work",
    );
    expect(git(fixture.gate, "rev-parse", `${tip}^`).trim()).toBe(
      fixture.upstreamSha,
    );
    // The fork itself was not touched.
    expect(git(fixture.fork, "rev-parse", "refs/heads/main").trim()).toBe(
      fixture.forkSha,
    );
    // The scratch worktree was discarded.
    const scratch = join(
      env.xdgStateDir,
      "upkeep-axi",
      "firstmate-sync",
      `apply-${fixture.upstreamSha.slice(0, 7)}`,
    );
    expect(existsSync(scratch)).toBe(false);
    expect(
      git(fixture.clone, "worktree", "list").trim().split("\n"),
    ).toHaveLength(1);
    // The gate's own words are in the report, verbatim.
    const output = report.output as Array<Record<string, string>>;
    expect(
      output.some((row) =>
        row.detail.includes("no-mistakes: pipeline started"),
      ),
    ).toBe(true);
  });

  it("refuses a conflicting sync with the conflicting files, and journals nothing", async () => {
    const fixture = buildFixture("conflicts");
    const env = firstmateEnv(fixture);
    const report = await applyJson(env, ["--execute"]);
    const skipped = report.skipped as Array<Record<string, string>>;
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({
      surface: "firstmate",
      tool: "firstmate",
    });
    expect(skipped[0].reason).toContain("the trial rebase conflicts");
    expect(skipped[0].reason).toContain("shared.txt");
    expect(report.plan).toHaveLength(0);
    const journalResult = await runCli(["journal", "--json"], env.env());
    expect(
      (JSON.parse(journalResult.stdout) as { records: unknown[] }).records,
    ).toHaveLength(0);
  });

  it("plans nothing for a current fork beyond the no-updates skip", async () => {
    const fixture = buildFixture("current");
    const env = firstmateEnv(fixture);
    const report = await applyJson(env, []);
    expect(report.plan).toHaveLength(0);
    const skipped = report.skipped as Array<Record<string, string>>;
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe("no updates");
  });
});
