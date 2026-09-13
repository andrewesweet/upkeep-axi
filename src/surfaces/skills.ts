import { pathCandidates } from "../exec.js";
import type { Surface, SurfaceContext, ToolStatus } from "../types.js";
import {
  deferredMutation,
  enrichWithConfig,
  managerErrorRow,
} from "./shared.js";

const SURFACE_ID = "skills";
const LIST_TIMEOUT_MS = 30_000;

function managerPath(ctx: SurfaceContext): string | undefined {
  return pathCandidates("skills", ctx.env)[0];
}

function npxPath(ctx: SurfaceContext): string | undefined {
  return pathCandidates("npx", ctx.env)[0];
}

/**
 * How to run the skills CLI on this host: a `skills` binary on PATH when one
 * exists, otherwise `npx -y skills`, which is how the host reaches it.
 */
interface SkillsInvocation {
  file: string;
  prefix: string[];
}

function invocation(ctx: SurfaceContext): SkillsInvocation | undefined {
  const skills = managerPath(ctx);
  if (skills) return { file: skills, prefix: [] };
  const npx = npxPath(ctx);
  if (npx) return { file: npx, prefix: ["-y", "skills"] };
  return undefined;
}

/**
 * Parse `skills list -g`: one skill name per non-indented row, followed by a
 * path column, with `Agents:`/`Source:` detail lines indented underneath and
 * ANSI styling throughout. A row counts as a skill only when its second
 * column looks like a path, which keeps section headers out.
 */
export function parseSkillsList(stdout: string): string[] {
  const names: string[] = [];
  // eslint-disable-next-line no-control-regex -- ANSI CSI strips are control chars by design
  const ansi = /\x1b\[[0-9;]*m/g;
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(ansi, "");
    if (!line.trim() || /^\s/.test(line)) continue;
    const columns = line.trim().split(/\s{2,}/);
    if (columns.length < 2 || !/^[~/.]/.test(columns[1])) continue;
    names.push(columns[0]);
  }
  return names;
}

/**
 * Agent skills under ~/.agents/skills, inventoried by the skills CLI. The
 * CLI exposes a listing (`skills list -g`) and a mutating update
 * (`skills update`), but no update check - so this surface reports
 * installed only: every row carries its apply command and no version,
 * latest, or tier, because the manager itself reports none. Reached via
 * `npx -y skills` where no `skills` binary is on PATH.
 */
export const skillsSurface: Surface = {
  id: SURFACE_ID,
  description:
    "skills CLI-managed agent skills (installed only; no update check exposed)",
  managerTool: "skills",

  async detect(ctx) {
    return invocation(ctx) !== undefined;
  },

  async status(ctx) {
    const inv = invocation(ctx);
    if (!inv) return [];
    const list = await ctx.exec(
      inv.file,
      [...inv.prefix, "list", "-g"],
      LIST_TIMEOUT_MS,
    );
    const names =
      list.code === 0 && !list.timedOut ? parseSkillsList(list.stdout) : [];
    if (list.code !== 0 && names.length === 0) {
      return enrichWithConfig(ctx, SURFACE_ID, [
        managerErrorRow(
          SURFACE_ID,
          "skills",
          undefined,
          `skills list -g failed (exit ${list.code}${list.timedOut ? ", timed out" : ""})`,
        ),
      ]);
    }
    const rows: ToolStatus[] = names.map((name) => ({
      surface: SURFACE_ID,
      tool: name,
      installed: true,
      applyCommand: `skills update -g ${name}`,
    }));
    return enrichWithConfig(ctx, SURFACE_ID, rows);
  },

  async apply() {
    deferredMutation(SURFACE_ID, "apply");
  },

  async pin() {
    deferredMutation(SURFACE_ID, "pin");
  },
};
