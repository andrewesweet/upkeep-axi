import { tierBetween } from "../semver.js";
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

const SURFACE_ID = "uv";
const LIST_TIMEOUT_MS = 30_000;

interface UvTool {
  name: string;
  version: string;
}

function managerPath(ctx: SurfaceContext): string | undefined {
  return pathCandidates("uv", ctx.env)[0];
}

/** The vendor's own updater for one tool, fixed argv. */
function delegateFor(
  ctx: SurfaceContext,
  name: string,
): ApplyDelegate | undefined {
  const uv = managerPath(ctx);
  if (!uv) return undefined;
  return { steps: [{ file: uv, args: ["tool", "upgrade", name] }] };
}

/** Parse `uv tool list` lines: `name v1.2.3`, skipping the `- bin` lines. */
export function parseUvToolList(stdout: string): UvTool[] {
  const tools: UvTool[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith("-")) continue;
    // uv always prints the installed version with a `v` prefix; requiring it
    // keeps tool names whose binaries embed digits from parsing as versions.
    const match = line.match(/^(\S+) v(\S+)\s*$/);
    if (match) tools.push({ name: match[1], version: match[2] });
  }
  return tools;
}

/** Parse `uv tool list --outdated`: `name vOLD [latest: NEW]`. */
export function parseUvOutdated(stdout: string): Map<string, string> {
  const latest = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    if (line.startsWith("-")) continue;
    const match = line.match(/^(\S+) v\S+ \[latest: (\S+)\]/);
    if (match) latest.set(match[1], match[2]);
  }
  return latest;
}

/**
 * uv-managed tools. Installed tools come from `uv tool list`; available
 * versions come from the upgrade check the uv CLI exposes,
 * `uv tool list --outdated`, which lists only tools it found updates for -
 * a tool absent there keeps its latest and tier absent. The uv binary
 * itself is not part of this surface; where mise owns it, the mise surface
 * reports it.
 */
export const uvSurface: Surface = {
  id: SURFACE_ID,
  description: "uv-managed tools",
  managerTool: "uv",

  async detect(ctx) {
    return managerPath(ctx) !== undefined;
  },

  async status(ctx) {
    const uv = managerPath(ctx);
    if (!uv) return [];
    const list = await ctx.exec(uv, ["tool", "list"], LIST_TIMEOUT_MS);
    const installed = parseUvToolList(list.stdout);
    if (list.code !== 0 && installed.length === 0) {
      const version = await managerVersion(ctx, uv);
      return enrichWithConfig(ctx, SURFACE_ID, [
        managerErrorRow(
          SURFACE_ID,
          "uv",
          version,
          `uv tool list failed (exit ${list.code}${list.timedOut ? ", timed out" : ""})`,
        ),
      ]);
    }
    const outdated = await ctx.exec(
      uv,
      ["tool", "list", "--outdated"],
      LIST_TIMEOUT_MS,
    );
    const latestMap = parseUvOutdated(outdated.stdout);
    const rows: ToolStatus[] = installed.map((tool) => {
      const latest = latestMap.get(tool.name);
      return {
        surface: SURFACE_ID,
        tool: tool.name,
        installed: true,
        version: tool.version,
        latest,
        tier: tierBetween(tool.version, latest),
        applyCommand: applyCommandText(delegateFor(ctx, tool.name)!),
        pinCommand: `uv tool install ${tool.name}==${tool.version}`,
      };
    });
    return enrichWithConfig(ctx, SURFACE_ID, rows);
  },

  apply(ctx, row) {
    return delegateFor(ctx, row.tool);
  },
};
