import { extractVersion } from "../semver.js";
import { pathCandidates } from "../exec.js";
import type { Surface, SurfaceContext, ToolStatus } from "../types.js";
import { deferredMutation, enrichWithConfig } from "./shared.js";

const SURFACE_ID = "pi";
const LIST_TIMEOUT_MS = 15_000;

function managerPath(ctx: SurfaceContext): string | undefined {
  return pathCandidates("pi", ctx.env)[0];
}

/**
 * Parse `pi list` output: package source lines are indented two spaces, the
 * dimmed install-path lines under them four; `User:`/`Project:` headers and
 * the bare "No packages installed." line start at column zero. `pi list`
 * prints the install source, not a version, so package rows carry no
 * version - the source is the only identity the vendor reports.
 */
export function parsePiList(stdout: string): string[] {
  const sources: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("  ") || line.startsWith("    ")) continue;
    const text = line.trim().replace(/ \(filtered\)$/, "");
    if (text) sources.push(text);
  }
  return sources;
}

/**
 * Pi and its packages. Pi's own version comes from `pi --version`; packages
 * come from `pi list`, which reports install sources without versions. The
 * vendor's updater is `pi update` (self for pi, a source for one package).
 * Pi announces newer releases itself, so latest and tier stay absent here;
 * the configured announcement probe carries the tool's own claim.
 */
export const piSurface: Surface = {
  id: SURFACE_ID,
  description: "Pi and its packages",
  managerTool: "pi",

  async detect(ctx) {
    return managerPath(ctx) !== undefined;
  },

  async status(ctx) {
    const pi = managerPath(ctx);
    if (!pi) return [];
    const probe = await ctx.exec(pi, ["--version"]);
    const version =
      extractVersion(probe.stdout) ?? extractVersion(probe.stderr);
    const list = await ctx.exec(pi, ["list"], LIST_TIMEOUT_MS);
    const sources = parsePiList(list.stdout);
    const piRow: ToolStatus = {
      surface: SURFACE_ID,
      tool: SURFACE_ID,
      installed: true,
      version,
      applyCommand: "pi update self",
    };
    if (list.code !== 0 && sources.length === 0) {
      piRow.error = `pi list failed (exit ${list.code}${list.timedOut ? ", timed out" : ""})`;
      return enrichWithConfig(ctx, SURFACE_ID, [piRow]);
    }
    const rows: ToolStatus[] = [piRow];
    for (const source of sources) {
      rows.push({
        surface: SURFACE_ID,
        tool: source,
        installed: true,
        applyCommand: `pi update ${source}`,
      });
    }
    return enrichWithConfig(ctx, SURFACE_ID, rows);
  },

  async apply() {
    deferredMutation(SURFACE_ID, "apply");
  },

  async pin() {
    deferredMutation(SURFACE_ID, "pin");
  },
};
