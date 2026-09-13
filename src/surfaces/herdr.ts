import { homedir } from "node:os";
import { join } from "node:path";
import { pathCandidates } from "../exec.js";
import type { Surface, SurfaceContext, ToolStatus } from "../types.js";
import {
  deferredMutation,
  enrichWithConfig,
  managerVersion,
  readJsonFile,
} from "./shared.js";

const SURFACE_ID = "herdr";

interface HerdrPlugin {
  plugin_id?: unknown;
  name?: unknown;
  version?: unknown;
}

function managerPath(ctx: SurfaceContext): string | undefined {
  return pathCandidates("herdr", ctx.env)[0];
}

/** Herdr keeps its state under $XDG_CONFIG_HOME/herdr (default ~/.config). */
function herdrConfigDir(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME ?? join(env.HOME ?? homedir(), ".config");
  return join(xdg, "herdr");
}

/**
 * Herdr and its plugins. Herdr's own version comes from `herdr --version`
 * and its updater is `herdr update`; plugins are read from Herdr's
 * plugins.json, which records each plugin's id and version. Herdr exposes no
 * plugin update or pin command, so plugin rows carry no apply or pin - the
 * absence is the vendor's, not a guess. Disabled plugins stay installed, so
 * they are reported like any other. A plugins.json that exists but does not
 * parse is reported verbatim on the herdr row.
 */
export const herdrSurface: Surface = {
  id: SURFACE_ID,
  description: "Herdr and its plugins",
  managerTool: "herdr",

  async detect(ctx) {
    return managerPath(ctx) !== undefined;
  },

  async status(ctx) {
    const herdr = managerPath(ctx);
    if (!herdr) return [];
    const version = await managerVersion(ctx, herdr);
    const herdrRow: ToolStatus = {
      surface: SURFACE_ID,
      tool: SURFACE_ID,
      installed: true,
      version,
      applyCommand: "herdr update",
    };
    const parsed = readJsonFile<HerdrPlugin[]>(
      join(herdrConfigDir(ctx.env), "plugins.json"),
    );
    if ("invalid" in parsed) {
      herdrRow.error = "herdr plugins.json is not valid JSON";
      return enrichWithConfig(ctx, SURFACE_ID, [herdrRow]);
    }
    const rows: ToolStatus[] = [herdrRow];
    if ("value" in parsed && Array.isArray(parsed.value)) {
      for (const plugin of parsed.value) {
        if (plugin === null || typeof plugin !== "object") continue;
        const id =
          typeof plugin.plugin_id === "string" ? plugin.plugin_id : undefined;
        const name = typeof plugin.name === "string" ? plugin.name : undefined;
        const tool = id ?? name;
        if (!tool) continue;
        rows.push({
          surface: SURFACE_ID,
          tool,
          installed: true,
          version:
            typeof plugin.version === "string" ? plugin.version : undefined,
        });
      }
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
