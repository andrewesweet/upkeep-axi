import { homedir } from "node:os";
import { join } from "node:path";
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
  managerVersion,
  readJsonFile,
} from "./shared.js";

const SURFACE_ID = "claude";

interface ClaudeSettings {
  enabledPlugins?: Record<string, unknown>;
}

interface InstalledEntry {
  scope?: unknown;
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

/**
 * The vendor's own updater, keyed by row kind: the binary updates itself,
 * a plugin row (spelled `name@marketplace`) updates through the plugin
 * command, a marketplace row through the marketplace command.
 */
type ClaudeRowKind = "self" | "plugin" | "marketplace";

function rowKind(tool: string): ClaudeRowKind {
  if (tool === SURFACE_ID) return "self";
  return tool.includes("@") ? "plugin" : "marketplace";
}

function delegateFor(
  ctx: SurfaceContext,
  kind: ClaudeRowKind,
  name: string,
): ApplyDelegate | undefined {
  const claude = managerPath(ctx);
  if (!claude) return undefined;
  if (kind === "self") return { steps: [{ file: claude, args: ["update"] }] };
  if (kind === "plugin") {
    return { steps: [{ file: claude, args: ["plugin", "update", name] }] };
  }
  return {
    steps: [{ file: claude, args: ["plugin", "marketplace", "update", name] }],
  };
}

/** Claude reads its state from $CLAUDE_CONFIG_DIR, default ~/.claude. */
function claudeDir(env: NodeJS.ProcessEnv): string {
  const override = env.CLAUDE_CONFIG_DIR;
  if (override) return override;
  const home = env.HOME ?? homedir();
  return join(home, ".claude");
}

/**
 * Claude Code, its plugins, and its marketplaces. The binary reports
 * `claude --version`; plugins and marketplaces are read from Claude's own
 * state files, never re-derived: enabled plugins from settings.json, install
 * facts and versions from plugins/installed_plugins.json, marketplaces from
 * plugins/known_marketplaces.json. A plugin enabled in settings but absent
 * from a readable install record reports installed=false; an unreadable
 * install record yields no plugin rows at all. Updates announce
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
      settings.value?.enabledPlugins &&
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
      installed.value?.plugins &&
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
      "value" in marketplaces &&
      marketplaces.value !== null &&
      typeof marketplaces.value === "object"
        ? marketplaces.value
        : {};

    const claudeRow: ToolStatus = {
      surface: SURFACE_ID,
      tool: SURFACE_ID,
      installed: true,
      version,
      applyCommand: applyCommandText(delegateFor(ctx, "self", SURFACE_ID)!),
      pinCommand: version ? `claude install ${version}` : undefined,
    };
    if (details.length > 0) claudeRow.error = details.join("; ");

    const rows: ToolStatus[] = [claudeRow];
    const pluginKeys =
      "invalid" in installed ? [] : Object.entries(enabledPlugins);
    for (const [key, enabled] of pluginKeys) {
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
        version: typeof entry.version === "string" ? entry.version : undefined,
        applyCommand: applyCommandText(delegateFor(ctx, "plugin", key)!),
      });
    }
    for (const name of Object.keys(marketplaceMap)) {
      rows.push({
        surface: SURFACE_ID,
        tool: name,
        installed: true,
        applyCommand: applyCommandText(delegateFor(ctx, "marketplace", name)!),
      });
    }
    return enrichWithConfig(ctx, SURFACE_ID, rows);
  },

  apply(ctx, row) {
    if (!row.applyCommand) return undefined;
    return delegateFor(ctx, rowKind(row.tool), row.tool);
  },

  /** Updating claude or its plugins replaces files the running binary reads. */
  replacedExecutables: () => [SURFACE_ID],
};
