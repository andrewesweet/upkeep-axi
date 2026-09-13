import { extractVersion, tierBetween } from "../semver.js";
import { pathCandidates } from "../exec.js";
import type {
  ApplyDelegate,
  Surface,
  SurfaceContext,
  ToolStatus,
} from "../types.js";
import { applyCommandText, enrichWithConfig } from "./shared.js";

const SURFACE_ID = "codex";
const PACKAGE = "@openai/codex";
const VIEW_TIMEOUT_MS = 15_000;

function managerPath(ctx: SurfaceContext): string | undefined {
  return pathCandidates("codex", ctx.env)[0];
}

/** The vendor's own updater; the standalone installer exposes no pin. */
function delegateFor(ctx: SurfaceContext): ApplyDelegate | undefined {
  const codex = managerPath(ctx);
  if (!codex) return undefined;
  return { steps: [{ file: codex, args: ["update"] }] };
}

/**
 * Codex CLI. The installed version comes from `codex --version`; the
 * available version comes from the npm registry check Codex's own docs give,
 * `npm view @openai/codex version`. A missing npm or a failed view keeps
 * latest and tier absent - the row keeps whatever facts survived. Codex
 * updates itself with `codex update`; its installer exposes no pin, so the
 * pin stays absent.
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
      applyCommand: applyCommandText(delegateFor(ctx)!),
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

  apply(ctx) {
    return delegateFor(ctx);
  },
};
