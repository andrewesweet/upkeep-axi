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

const SURFACE_ID = "claude";

interface ClaudeSettings {
  enabledPlugins?: Record<string, unknown>;
}

interface InstalledEntry {
  scope?: unknown;
  installPath?: unknown;
  version?: unknown;
}

interface InstalledPlugins {
  plugins?: Record<string, InstalledEntry[]>;
}

interface KnownMarketplaces {
  [name: string]: Record<string, unknown>;
}

function managerPath(ctx: SurfaceContext): string | undefined {
  return pathCandidates("claude", ctx.env)[0];
}

/** Claude reads its state from $CLAUDE_CONFIG_DIR, default ~/.claude. */
function claudeDir(env: NodeJS.ProcessEnv): string {
  const override = env.CLAUDE_CONFIG_DIR;
  if (override) return override;
  const home = env.HOME ?? homedir();
  return join(home, ".claude");
}

/**
 * The plugin's own manifest is the first version source; the version the
 * installer recorded in installed_plugins.json is the fallback. Neither is a
 * version, so the row reports installed only.
 */
function pluginVersion(entry: InstalledEntry): string | undefined {
  const installPath =
    typeof entry.installPath === "string" ? entry.installPath : undefined;
  if (installPath) {
    const manifest = readJsonFile<{ version?: unknown }>(
      join(installPath, ".claude-plugin", "plugin.json"),
    );
    if ("value" in manifest && typeof manifest.value.version === "string") {
      return manifest.value.version;
    }
  }
  return typeof entry.version === "string" ? entry.version : undefined;
}

/**
 * Claude Code, its plugins, and its marketplaces. The binary reports
 * `claude --version`; plugins and marketplaces are read from Claude's own
 * state files, never re-derived: enabled plugins from settings.json, install
 * facts from plugins/installed_plugins.json, marketplaces from
 * plugins/known_marketplaces.json. A plugin enabled in settings but absent
 * from the install record reports installed=false. Updates announce
 * themselves, so latest and tier stay absent here; the configured
 * announcement probe carries the tool's own claim. A state file that exists
 * but does not parse is reported verbatim on the claude row, and every fact
 * that survived is kept.
 */
export const claudeSurface: Surface = {
  id: SURFACE_ID,
  description: "Claude Code, its plugins, and marketplaces",
  managerTool: "claude",

  async detect(ctx) {
    return managerPath(ctx) !== undefined;
  },

  async status(ctx) {
    const claude = managerPath(ctx);
    if (!claude) return [];
    const version = await managerVersion(ctx, claude);
    const dir = claudeDir(ctx.env);
    const details: string[] = [];

    const settings = readJsonFile<ClaudeSettings>(join(dir, "settings.json"));
    if ("invalid" in settings) {
      details.push("claude settings.json is not valid JSON");
    }
    const enabledPlugins =
      "value" in settings &&
      settings.value.enabledPlugins &&
      typeof settings.value.enabledPlugins === "object"
        ? settings.value.enabledPlugins
        : {};

    const installed = readJsonFile<InstalledPlugins>(
      join(dir, "plugins", "installed_plugins.json"),
    );
    if ("invalid" in installed) {
      details.push("claude installed_plugins.json is not valid JSON");
    }
    const installedMap =
      "value" in installed &&
      installed.value.plugins &&
      typeof installed.value.plugins === "object"
        ? installed.value.plugins
        : {};

    const marketplaces = readJsonFile<KnownMarketplaces>(
      join(dir, "plugins", "known_marketplaces.json"),
    );
    if ("invalid" in marketplaces) {
      details.push("claude known_marketplaces.json is not valid JSON");
    }
    const marketplaceMap =
      "value" in marketplaces && typeof marketplaces.value === "object"
        ? marketplaces.value
        : {};

    const claudeRow: ToolStatus = {
      surface: SURFACE_ID,
      tool: SURFACE_ID,
      installed: true,
      version,
      applyCommand: "claude update",
      pinCommand: version ? `claude install ${version}` : undefined,
    };
    if (details.length > 0) claudeRow.error = details.join("; ");

    const rows: ToolStatus[] = [claudeRow];
    for (const [key, enabled] of Object.entries(enabledPlugins)) {
      if (enabled !== true) continue;
      const entries = Array.isArray(installedMap[key])
        ? installedMap[key].filter(
            (entry): entry is InstalledEntry =>
              entry !== null && typeof entry === "object",
          )
        : [];
      if (entries.length === 0) {
        rows.push({ surface: SURFACE_ID, tool: key, installed: false });
        continue;
      }
      const entry =
        entries.find((candidate) => candidate.scope === "user") ??
        entries[entries.length - 1];
      if (!entry) continue;
      rows.push({
        surface: SURFACE_ID,
        tool: key,
        installed: true,
        version: pluginVersion(entry),
        applyCommand: `claude plugin update ${key}`,
      });
    }
    for (const name of Object.keys(marketplaceMap)) {
      rows.push({
        surface: SURFACE_ID,
        tool: name,
        installed: true,
        applyCommand: `claude plugin marketplace update ${name}`,
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
