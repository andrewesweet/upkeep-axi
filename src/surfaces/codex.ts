import { extractVersion, tierBetween } from "../semver.js";
import { pathCandidates } from "../exec.js";
import type { Surface, SurfaceContext, ToolStatus } from "../types.js";
import { deferredMutation, enrichWithConfig } from "./shared.js";

const SURFACE_ID = "codex";
const PACKAGE = "@openai/codex";
const VIEW_TIMEOUT_MS = 15_000;

function managerPath(ctx: SurfaceContext): string | undefined {
  return pathCandidates("codex", ctx.env)[0];
}

/**
 * Codex CLI. The installed version comes from `codex --version`; the
 * available version comes from the npm registry check Codex's own docs give,
 * `npm view @openai/codex version`. A missing npm or a failed view keeps
 * latest and tier absent - the row keeps whatever facts survived.
 */
export const codexSurface: Surface = {
  id: SURFACE_ID,
  description: "Codex CLI",
  managerTool: "codex",

  async detect(ctx) {
    return managerPath(ctx) !== undefined;
  },

  async status(ctx) {
    const codex = managerPath(ctx);
    if (!codex) return [];
    const probe = await ctx.exec(codex, ["--version"]);
    const version =
      extractVersion(probe.stdout) ?? extractVersion(probe.stderr);
    const row: ToolStatus = {
      surface: SURFACE_ID,
      tool: SURFACE_ID,
      installed: true,
      version,
      applyCommand: `npm install -g ${PACKAGE}@latest`,
      pinCommand: version ? `npm install -g ${PACKAGE}@${version}` : undefined,
    };
    const npm = pathCandidates("npm", ctx.env)[0];
    if (npm) {
      const view = await ctx.exec(
        npm,
        ["view", PACKAGE, "version"],
        VIEW_TIMEOUT_MS,
      );
      if (view.code === 0 && !view.timedOut) {
        row.latest = extractVersion(view.stdout) ?? extractVersion(view.stderr);
      }
    }
    row.tier = tierBetween(row.version, row.latest);
    return enrichWithConfig(ctx, SURFACE_ID, [row]);
  },

  async apply() {
    deferredMutation(SURFACE_ID, "apply");
  },

  async pin() {
    deferredMutation(SURFACE_ID, "pin");
  },
};
