import { tierBetween } from "../semver.js";
import { pathCandidates } from "../exec.js";
import type { Surface, SurfaceContext, ToolStatus } from "../types.js";
import {
  deferredMutation,
  enrichWithConfig,
  managerErrorRow,
  managerVersion,
} from "./shared.js";

const SURFACE_ID = "gh";
const LIST_TIMEOUT_MS = 15_000;
const DRY_RUN_TIMEOUT_MS = 30_000;

function managerPath(ctx: SurfaceContext): string | undefined {
  return pathCandidates("gh", ctx.env)[0];
}

export interface GhExtension {
  name: string;
  repo?: string;
  version?: string;
}

/**
 * Parse `gh extension list`: one `NAME<TAB>REPO[<TAB>VERSION]` row per
 * extension, as gh prints it to a pipe. The list spells
 * names with a `gh ` prefix while upgrade and install spell them bare, so the
 * prefix is stripped here; a `-` repo marks a local extension, which is no
 * repo at all.
 */
export function parseGhExtensionList(stdout: string): GhExtension[] {
  const extensions: GhExtension[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const fields = line
      .split("\t")
      .map((field) => field.trim())
      .filter(Boolean);
    if (fields.length < 2) continue;
    extensions.push({
      name: fields[0].replace(/^gh /, ""),
      repo: fields[1] === "-" ? undefined : fields[1],
      version: fields[2],
    });
  }
  return extensions;
}

export interface GhUpgradeVerdict {
  latest?: string;
  pinned: boolean;
}

/**
 * Parse `gh extension upgrade --all --dry-run`: one `[name]: verdict` line
 * per extension, per gh's own output contract. `would have upgraded from X
 * to Y` carries the available version; `already up to date` carries none,
 * and a pinned extension reports as pinned - its upgrade would refuse.
 */
export function parseGhUpgradeDryRun(
  stdout: string,
): Map<string, GhUpgradeVerdict> {
  const verdicts = new Map<string, GhUpgradeVerdict>();
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\[(.+?)\]:\s*(.*)$/);
    if (!match) continue;
    const verdict = match[2];
    const upgrade = verdict.match(/would have upgraded from (\S+) to (\S+)/);
    if (upgrade) {
      verdicts.set(match[1], { latest: upgrade[2], pinned: false });
    } else {
      verdicts.set(match[1], {
        pinned: verdict.includes("pinned extensions can not be upgraded"),
      });
    }
  }
  return verdicts;
}

/**
 * gh itself and its extensions. gh's own version comes from `gh --version`;
 * gh exposes no self-update check, so its latest and tier stay absent, and
 * where a package manager owns gh that surface carries the upgrade command.
 * Extensions come from `gh extension list`; available versions come from the
 * check gh itself exposes, `gh extension upgrade --all --dry-run`, which
 * reports only extensions it would upgrade - absent there means no known
 * update. A pinned extension carries no apply command, because its upgrade
 * would refuse. gh has no extension pin command, so pins stay absent.
 */
export const ghSurface: Surface = {
  id: SURFACE_ID,
  description: "gh itself and its extensions",
  managerTool: "gh",

  async detect(ctx) {
    return managerPath(ctx) !== undefined;
  },

  async status(ctx) {
    const gh = managerPath(ctx);
    if (!gh) return [];
    const selfVersion = await managerVersion(ctx, gh);
    const list = await ctx.exec(gh, ["extension", "list"], LIST_TIMEOUT_MS);
    const extensions = parseGhExtensionList(list.stdout);
    if (list.code !== 0 && extensions.length === 0) {
      return enrichWithConfig(ctx, SURFACE_ID, [
        managerErrorRow(
          SURFACE_ID,
          "gh",
          selfVersion,
          `gh extension list failed (exit ${list.code}${list.timedOut ? ", timed out" : ""})`,
        ),
      ]);
    }
    const dryRun = await ctx.exec(
      gh,
      ["extension", "upgrade", "--all", "--dry-run"],
      DRY_RUN_TIMEOUT_MS,
    );
    const verdicts =
      dryRun.code === 0 && !dryRun.timedOut
        ? parseGhUpgradeDryRun(dryRun.stdout)
        : new Map<string, GhUpgradeVerdict>();
    const rows: ToolStatus[] = [
      {
        surface: SURFACE_ID,
        tool: SURFACE_ID,
        installed: true,
        version: selfVersion,
      },
      ...extensions.map((extension) => {
        const verdict = verdicts.get(extension.name);
        return {
          surface: SURFACE_ID,
          tool: extension.name,
          installed: true,
          version: extension.version,
          latest: verdict?.latest,
          tier: tierBetween(extension.version, verdict?.latest),
          applyCommand:
            verdict?.pinned || !extension.repo
              ? undefined
              : `gh extension upgrade ${extension.name}`,
        };
      }),
    ];
    return enrichWithConfig(ctx, SURFACE_ID, rows);
  },

  async apply() {
    deferredMutation(SURFACE_ID, "apply");
  },

  async pin() {
    deferredMutation(SURFACE_ID, "pin");
  },
};
