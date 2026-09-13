import { extractVersion, tierBetween } from "../semver.js";
import { mapLimit, pathCandidates } from "../exec.js";
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
  parseJsonOutput,
} from "./shared.js";

const SURFACE_ID = "npm";
const LIST_TIMEOUT_MS = 15_000;
const VIEW_TIMEOUT_MS = 15_000;
const PROBE_CONCURRENCY = 8;

interface NpmLsOutput {
  dependencies?: Record<string, { version?: unknown }>;
}

function managerPath(ctx: SurfaceContext): string | undefined {
  return pathCandidates("npm", ctx.env)[0];
}

/** The vendor's own updater for one global package, fixed argv. */
function delegateFor(
  ctx: SurfaceContext,
  name: string,
): ApplyDelegate | undefined {
  const npm = managerPath(ctx);
  if (!npm) return undefined;
  return { steps: [{ file: npm, args: ["install", "-g", `${name}@latest`] }] };
}

/**
 * npm global packages. Installed versions come from `npm ls -g --json`;
 * the available version of each package comes from `npm view <pkg> version`,
 * the exact check npm itself exposes. A package whose view fails keeps its
 * latest and tier absent. upkeep-axi itself, when installed as a global
 * package, is inventoried here like any other: the self-update pass is the
 * npm pass.
 */
export const npmSurface: Surface = {
  id: SURFACE_ID,
  description: "Global npm packages",
  managerTool: "npm",

  async detect(ctx) {
    return managerPath(ctx) !== undefined;
  },

  async status(ctx) {
    const npm = managerPath(ctx);
    if (!npm) return [];
    const ls = await ctx.exec(npm, ["ls", "-g", "--json"], LIST_TIMEOUT_MS);
    const parsed = parseJsonOutput<NpmLsOutput>(ls.stdout);
    const dependencies = parsed?.dependencies;
    if (!dependencies || typeof dependencies !== "object") {
      const version = await managerVersion(ctx, npm);
      return enrichWithConfig(ctx, SURFACE_ID, [
        managerErrorRow(
          SURFACE_ID,
          "npm",
          version,
          `npm ls -g --json failed (exit ${ls.code}${ls.timedOut ? ", timed out" : ""})`,
        ),
      ]);
    }
    const names = Object.keys(dependencies);
    const rows: ToolStatus[] = await mapLimit(
      names,
      PROBE_CONCURRENCY,
      async (name) => {
        const reported = dependencies[name]?.version;
        const version = typeof reported === "string" ? reported : undefined;
        const row: ToolStatus = {
          surface: SURFACE_ID,
          tool: name,
          installed: true,
          version: version || undefined,
        };
        const view = await ctx.exec(
          npm,
          ["view", name, "version"],
          VIEW_TIMEOUT_MS,
        );
        if (view.code === 0 && !view.timedOut) {
          row.latest =
            extractVersion(view.stdout) ?? extractVersion(view.stderr);
        }
        row.tier = tierBetween(row.version, row.latest);
        // npm is on PATH here (status returned early otherwise), so the
        // delegate always resolves for a discovered row.
        row.applyCommand = applyCommandText(delegateFor(ctx, name)!);
        row.pinCommand = row.version
          ? `npm install -g ${name}@${row.version}`
          : undefined;
        return row;
      },
    );
    return enrichWithConfig(ctx, SURFACE_ID, rows);
  },

  apply(ctx, row) {
    return delegateFor(ctx, row.tool);
  },

  /**
   * Replacing npm global files cannot disturb a running copy: package
   * directories are swapped wholesale and running processes keep their
   * open files. npm globals are safe while running.
   */
  replacedExecutables: () => [],
};
