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
} from "./shared.js";

const SURFACE_ID = "bun";
const LIST_TIMEOUT_MS = 15_000;
const VIEW_TIMEOUT_MS = 15_000;
const PROBE_CONCURRENCY = 8;

function managerPath(ctx: SurfaceContext): string | undefined {
  return pathCandidates("bun", ctx.env)[0];
}

/** The vendor's own updater for one global package, fixed argv. */
function delegateFor(
  ctx: SurfaceContext,
  name: string,
): ApplyDelegate | undefined {
  const bun = managerPath(ctx);
  if (!bun) return undefined;
  return { steps: [{ file: bun, args: ["install", "-g", `${name}@latest`] }] };
}

export interface BunGlobal {
  name: string;
  version: string;
}

/**
 * Parse `bun pm ls -g`: tree rows `name@version` under the global install
 * directory. Box-drawing prefixes are stripped and the split happens at the
 * last `@`, so scoped packages (`@scope/pkg@1.2.3`) parse whole. The header
 * line naming the global directory carries no `@` and never matches; a
 * version is additionally required to contain no `/`, which keeps paths in
 * headers from parsing as packages.
 */
export function parseBunGlobalList(stdout: string): BunGlobal[] {
  const globals: BunGlobal[] = [];
  for (const line of stdout.split("\n")) {
    const bare = line.replace(/^[\s│├└─]+/u, "");
    const match = bare.match(/^(.+)@([^\s/]+)$/);
    if (match) globals.push({ name: match[1], version: match[2] });
  }
  return globals;
}

/**
 * bun's global packages. Installed packages and versions come from
 * `bun pm ls -g`; the available version of each package comes from
 * `bun pm view <pkg> version`, the registry check the bun CLI itself
 * exposes. A package whose view fails keeps its latest and tier absent.
 */
export const bunSurface: Surface = {
  id: SURFACE_ID,
  description: "Global bun packages",
  managerTool: "bun",

  async detect(ctx) {
    return managerPath(ctx) !== undefined;
  },

  async status(ctx) {
    const bun = managerPath(ctx);
    if (!bun) return [];
    const ls = await ctx.exec(bun, ["pm", "ls", "-g"], LIST_TIMEOUT_MS);
    const installed = parseBunGlobalList(ls.stdout);
    if (ls.code !== 0 && installed.length === 0) {
      const version = await managerVersion(ctx, bun);
      return enrichWithConfig(ctx, SURFACE_ID, [
        managerErrorRow(
          SURFACE_ID,
          "bun",
          version,
          `bun pm ls -g failed (exit ${ls.code}${ls.timedOut ? ", timed out" : ""})`,
        ),
      ]);
    }
    const rows: ToolStatus[] = await mapLimit(
      installed,
      PROBE_CONCURRENCY,
      async (pkg) => {
        const view = await ctx.exec(
          bun,
          ["pm", "view", pkg.name, "version"],
          VIEW_TIMEOUT_MS,
        );
        const latest =
          view.code === 0 && !view.timedOut
            ? (extractVersion(view.stdout) ?? extractVersion(view.stderr))
            : undefined;
        return {
          surface: SURFACE_ID,
          tool: pkg.name,
          installed: true,
          version: pkg.version,
          latest,
          tier: tierBetween(pkg.version, latest),
          applyCommand: applyCommandText(delegateFor(ctx, pkg.name)!),
          pinCommand: `bun install -g ${pkg.name}@${pkg.version}`,
        };
      },
    );
    return enrichWithConfig(ctx, SURFACE_ID, rows);
  },

  apply(ctx, row) {
    return delegateFor(ctx, row.tool);
  },
};
