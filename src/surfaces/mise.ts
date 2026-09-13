import { tierBetween } from "../semver.js";
import { pathCandidates } from "../exec.js";
import type { Surface, SurfaceContext, ToolStatus } from "../types.js";
import {
  deferredMutation,
  enrichWithConfig,
  managerErrorRow,
  managerVersion,
  parseJsonOutput,
} from "./shared.js";

const SURFACE_ID = "mise";
const LS_TIMEOUT_MS = 15_000;

interface MiseLsOutput {
  [tool: string]: Array<{ version?: unknown; installed?: unknown }>;
}

interface MiseOutdatedEntry {
  latest?: unknown;
}

function managerPath(ctx: SurfaceContext): string | undefined {
  return pathCandidates(ctx.surface.command ?? "mise", ctx.env)[0];
}

/**
 * mise-managed tools plus mise itself. Installed tools and versions come from
 * `mise ls --json`; available versions come from `mise outdated --json`, which
 * lists only tools it found updates for - a tool absent there keeps its
 * latest and tier absent. mise itself reports `mise self-update` as its apply
 * command; its latest stays absent because no honest cheap probe exists.
 */
export const miseSurface: Surface = {
  id: SURFACE_ID,
  description: "mise-managed tools and mise itself",
  managerTool: "mise",

  async detect(ctx) {
    return managerPath(ctx) !== undefined;
  },

  async status(ctx) {
    const mise = managerPath(ctx);
    if (!mise) return [];
    const selfVersion = await managerVersion(ctx, mise);
    const ls = await ctx.exec(mise, ["ls", "--json"], LS_TIMEOUT_MS);
    const installed = parseJsonOutput<MiseLsOutput>(ls.stdout);
    if (!installed || typeof installed !== "object") {
      return enrichWithConfig(ctx, SURFACE_ID, [
        managerErrorRow(
          SURFACE_ID,
          "mise",
          selfVersion,
          `mise ls --json failed (exit ${ls.code}${ls.timedOut ? ", timed out" : ""})`,
        ),
      ]);
    }
    const outdated = await ctx.exec(
      mise,
      ["outdated", "--json"],
      LS_TIMEOUT_MS,
    );
    const outdatedMap = parseJsonOutput<Record<string, MiseOutdatedEntry>>(
      outdated.stdout,
    );
    const rows: ToolStatus[] = [];
    for (const [tool, entries] of Object.entries(installed)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (entry === null || typeof entry !== "object") continue;
        const installedFlag = entry.installed !== false;
        // A not-installed entry reports only its absence: a version here
        // would be mise's requested version, not an installed fact.
        if (!installedFlag) {
          rows.push({ surface: SURFACE_ID, tool, installed: false });
          continue;
        }
        const version =
          typeof entry.version === "string" ? entry.version : undefined;
        const latestRaw =
          outdatedMap && typeof outdatedMap === "object"
            ? outdatedMap[tool]?.latest
            : undefined;
        const latest = typeof latestRaw === "string" ? latestRaw : undefined;
        rows.push({
          surface: SURFACE_ID,
          tool,
          installed: true,
          version,
          latest,
          tier: tierBetween(version, latest),
          applyCommand: `mise upgrade ${tool}`,
          pinCommand: version ? `mise use ${tool}@${version}` : undefined,
        });
      }
    }
    if (!rows.some((row) => row.tool === SURFACE_ID)) {
      rows.unshift({
        surface: SURFACE_ID,
        tool: SURFACE_ID,
        installed: true,
        version: selfVersion,
        applyCommand: "mise self-update",
        pinCommand: selfVersion ? `mise self-update ${selfVersion}` : undefined,
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
