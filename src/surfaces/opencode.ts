import { extractVersion } from "../semver.js";
import { pathCandidates } from "../exec.js";
import type {
  ApplyDelegate,
  Surface,
  SurfaceContext,
  ToolStatus,
} from "../types.js";
import { applyCommandText, enrichWithConfig } from "./shared.js";

const SURFACE_ID = "opencode";

function managerPath(ctx: SurfaceContext): string | undefined {
  return pathCandidates("opencode", ctx.env)[0];
}

/** The vendor's own updater; the same command pins a specific version. */
function delegateFor(ctx: SurfaceContext): ApplyDelegate | undefined {
  const opencode = managerPath(ctx);
  if (!opencode) return undefined;
  return { steps: [{ file: opencode, args: ["upgrade"] }] };
}

/**
 * OpenCode. The installed version comes from `opencode --version`; the
 * vendor's own updater is `opencode upgrade`, which also takes a specific
 * version as its pin. OpenCode announces newer releases itself, so latest
 * and tier stay absent here; the configured announcement probe carries the
 * tool's own claim.
 */
export const opencodeSurface: Surface = {
  id: SURFACE_ID,
  description: "OpenCode",
  managerTool: "opencode",

  async detect(ctx) {
    return managerPath(ctx) !== undefined;
  },

  async status(ctx) {
    const opencode = managerPath(ctx);
    if (!opencode) return [];
    const probe = await ctx.exec(opencode, ["--version"]);
    const version =
      extractVersion(probe.stdout) ?? extractVersion(probe.stderr);
    const row: ToolStatus = {
      surface: SURFACE_ID,
      tool: SURFACE_ID,
      installed: true,
      version,
      applyCommand: applyCommandText(delegateFor(ctx)!),
      pinCommand: version ? `opencode upgrade ${version}` : undefined,
    };
    return enrichWithConfig(ctx, SURFACE_ID, [row]);
  },

  apply(ctx) {
    return delegateFor(ctx);
  },
};
