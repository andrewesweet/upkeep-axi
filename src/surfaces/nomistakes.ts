import { extractVersion } from "../semver.js";
import { pathCandidates } from "../exec.js";
import type { Surface, SurfaceContext, ToolStatus } from "../types.js";
import { deferredMutation, enrichWithConfig } from "./shared.js";

const SURFACE_ID = "no-mistakes";

function managerPath(ctx: SurfaceContext): string | undefined {
  return pathCandidates("no-mistakes", ctx.env)[0];
}

/**
 * no-mistakes. The installed version comes from `no-mistakes --version`;
 * the vendor's updater is `no-mistakes update`. There is no pin mechanism
 * and no cheap honest latest probe: the tool announces its own updates, so
 * the configured announcement probe carries that claim (Firstmate's
 * watched-tools points the pattern at `--help`, where the notice appears).
 */
export const noMistakesSurface: Surface = {
  id: SURFACE_ID,
  description: "no-mistakes",
  managerTool: "no-mistakes",

  async detect(ctx) {
    return managerPath(ctx) !== undefined;
  },

  async status(ctx) {
    const nomistakes = managerPath(ctx);
    if (!nomistakes) return [];
    const probe = await ctx.exec(nomistakes, ["--version"]);
    const version =
      extractVersion(probe.stdout) ?? extractVersion(probe.stderr);
    const row: ToolStatus = {
      surface: SURFACE_ID,
      tool: SURFACE_ID,
      installed: true,
      version,
      applyCommand: "no-mistakes update",
    };
    return enrichWithConfig(ctx, SURFACE_ID, [row]);
  },

  async apply() {
    deferredMutation(SURFACE_ID, "apply");
  },

  async pin() {
    deferredMutation(SURFACE_ID, "pin");
  },
};
