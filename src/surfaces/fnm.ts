import { compareVersions, parseVersion, tierBetween } from "../semver.js";
import { pathCandidates } from "../exec.js";
import type {
  ApplyDelegate,
  Surface,
  SurfaceContext,
  ToolStatus,
} from "../types.js";
import {
  applyCommandText,
  enrichWithConfig,
  managerErrorRow,
  managerVersion,
} from "./shared.js";

const SURFACE_ID = "fnm";
const LIST_TIMEOUT_MS = 15_000;
const LS_REMOTE_TIMEOUT_MS = 30_000;

function managerPath(ctx: SurfaceContext): string | undefined {
  return pathCandidates("fnm", ctx.env)[0];
}

/**
 * The vendor's own update is two acts - install the version, then make it
 * the default - so the delegate is two steps with `&&` semantics. Callers
 * gate on a concrete latest and a tier other than none: a default already
 * at or past the LTS must never be downgraded.
 */
function delegateFor(
  ctx: SurfaceContext,
  latest: string,
): ApplyDelegate | undefined {
  const fnm = managerPath(ctx);
  if (!fnm) return undefined;
  return {
    steps: [
      { file: fnm, args: ["install", latest] },
      { file: fnm, args: ["default", latest] },
    ],
  };
}

export interface FnmInstalledVersion {
  version: string;
  isDefault: boolean;
}

/**
 * Parse `fnm list`: one row per installed version, with the default alias
 * noted on its row. A `system` row names no version and never matches. The
 * version keeps the `v` prefix the manager prints, which `fnm default`
 * accepts verbatim.
 */
export function parseFnmList(stdout: string): FnmInstalledVersion[] {
  const installed: FnmInstalledVersion[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/v?(\d+(?:\.\d+){1,3})/);
    if (!match) continue;
    installed.push({
      version: match[0],
      isDefault: /\bdefault\b/.test(line),
    });
  }
  return installed;
}

/**
 * Latest LTS from `fnm ls-remote --lts`: the highest version among the rows
 * the manager lists (each `vX.Y.Z (Codename)`), computed rather than assumed
 * from row order.
 */
export function parseFnmLsRemote(stdout: string): string | undefined {
  let bestRaw: string | undefined;
  let best: [number, number, number] | undefined;
  for (const line of stdout.split("\n")) {
    const match = line.match(/v?(\d+(?:\.\d+){1,3})/);
    if (!match) continue;
    const parsed = parseVersion(match[0]);
    if (!parsed) continue;
    if (!best || compareVersions(parsed, best) > 0) {
      best = parsed;
      bestRaw = match[0];
    }
  }
  return bestRaw;
}

/**
 * fnm-managed node. Installed versions come from `fnm list`, collapsed to
 * one row - the default-alias version, or the last installed one when no
 * alias is set, which is what a fresh shell resolves. The latest LTS comes
 * from `fnm ls-remote --lts`. Installing a version does not make it the
 * default, so the apply command names both acts. It is only published when
 * a concrete latest is known (`fnm default` needs an exact target) and the
 * tier is not none: a default already at or past the LTS would otherwise be
 * downgraded by a copy of the command.
 */
export const fnmSurface: Surface = {
  id: SURFACE_ID,
  description: "fnm-managed node",
  managerTool: "fnm",

  async detect(ctx) {
    return managerPath(ctx) !== undefined;
  },

  async status(ctx) {
    const fnm = managerPath(ctx);
    if (!fnm) return [];
    const list = await ctx.exec(fnm, ["list"], LIST_TIMEOUT_MS);
    const installed = parseFnmList(list.stdout);
    if (list.code !== 0 && installed.length === 0) {
      const version = await managerVersion(ctx, fnm);
      return enrichWithConfig(ctx, SURFACE_ID, [
        managerErrorRow(
          SURFACE_ID,
          "fnm",
          version,
          `fnm list failed (exit ${list.code}${list.timedOut ? ", timed out" : ""})`,
        ),
      ]);
    }
    if (installed.length === 0) {
      return enrichWithConfig(ctx, SURFACE_ID, [
        { surface: SURFACE_ID, tool: "node", installed: false },
      ]);
    }
    const chosen =
      installed.find((entry) => entry.isDefault) ?? installed.at(-1);
    const remote = await ctx.exec(
      fnm,
      ["ls-remote", "--lts"],
      LS_REMOTE_TIMEOUT_MS,
    );
    const latest =
      remote.code === 0 && !remote.timedOut
        ? parseFnmLsRemote(remote.stdout)
        : undefined;
    const tier = tierBetween(chosen?.version, latest);
    const delegate =
      latest && tier !== "none" ? delegateFor(ctx, latest) : undefined;
    const rows: ToolStatus[] = [
      {
        surface: SURFACE_ID,
        tool: "node",
        installed: true,
        version: chosen?.version,
        latest,
        tier,
        applyCommand: delegate ? applyCommandText(delegate) : undefined,
        pinCommand: chosen ? `fnm default ${chosen.version}` : undefined,
      },
    ];
    return enrichWithConfig(ctx, SURFACE_ID, rows);
  },

  apply(ctx, row) {
    // The delegate exists only where the row published an apply command:
    // a concrete latest and a tier other than none.
    if (!row.applyCommand || !row.latest) return undefined;
    return delegateFor(ctx, row.latest);
  },
};
