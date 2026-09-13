import { homedir } from "node:os";
import { encode } from "@toon-format/toon";
import type { ToolStatus } from "./types.js";

export const SCHEMA_VERSION = 1;

/** Collapse the user's home directory to `~` for display. */
function collapseHome(path: string, homeDir: string = homedir()): string {
  return path.startsWith(homeDir) ? `~${path.slice(homeDir.length)}` : path;
}

export interface StatusReport {
  generatedAt: string;
  schemaVersion: number;
  tools: ToolStatus[];
}

/** The row shape of the tools[] block; TOON and JSON share the spelling. */
interface ToolRow {
  surface: string;
  tool: string;
  installed: boolean;
  version?: string;
  latest?: string;
  tier?: string;
  apply?: string;
  pin?: string;
}

function toToolRow(row: ToolStatus): ToolRow {
  return {
    surface: row.surface,
    tool: row.tool,
    installed: row.installed,
    version: row.version,
    latest: row.latest,
    tier: row.tier,
    apply: row.applyCommand,
    pin: row.pinCommand,
  };
}

interface SkewRow {
  surface: string;
  tool: string;
  command: string;
  resolvedPath: string;
  resolvedVersion?: string;
  newerPath: string;
  newerVersion?: string;
}

interface AnnounceRow {
  surface: string;
  tool: string;
  claim: string;
}

interface ErrorRow {
  surface: string;
  tool: string;
  detail: string;
}

interface StatusModel {
  generatedAt: string;
  schemaVersion: number;
  tools: ToolRow[];
  errors?: ErrorRow[];
  skew?: SkewRow[];
  announce?: AnnounceRow[];
}

/**
 * The normalized model behind both renderers: sparse facts (probe failures,
 * PATH skew, announcements) live in their own blocks joined on surface+tool,
 * never inlined into every row.
 */
export function statusModel(report: StatusReport): StatusModel {
  const model: StatusModel = {
    generatedAt: report.generatedAt,
    schemaVersion: report.schemaVersion,
    tools: report.tools.map(toToolRow),
  };
  const errors = report.tools.filter((row) => row.error);
  if (errors.length > 0) {
    model.errors = errors.map((row) => ({
      surface: row.surface,
      tool: row.tool,
      detail: row.error as string,
    }));
  }
  const skew = report.tools.filter((row) => row.skew);
  if (skew.length > 0) {
    model.skew = skew.map((row) => ({
      surface: row.surface,
      tool: row.tool,
      command: row.skew?.command as string,
      resolvedPath: row.skew?.resolvedPath as string,
      resolvedVersion: row.skew?.resolvedVersion,
      newerPath: row.skew?.newerPath as string,
      newerVersion: row.skew?.newerVersion,
    }));
  }
  const announce = report.tools.filter((row) => row.announcement);
  if (announce.length > 0) {
    model.announce = announce.map((row) => ({
      surface: row.surface,
      tool: row.tool,
      claim: row.announcement as string,
    }));
  }
  return model;
}

const HELP_HINTS = [
  "Run `upkeep-axi status --surface <id>` to scope to one surface",
  "Run `upkeep-axi status --json` for the normalized model",
];

/** Default output: compact TOON, decision-shaped, with a help block. */
export function renderStatusToon(
  report: StatusReport,
  binPath: string,
  description: string,
): string {
  const body: Record<string, unknown> = {
    bin: collapseHome(binPath),
    description,
    ...statusModel(report),
  };
  const help =
    report.tools.length > 0
      ? HELP_HINTS
      : [
          "Run `upkeep-axi status --surface <id>` to scope to one surface",
          "Every configured surface is missing or disabled; check the config file",
        ];
  return `${encode(body)}\nhelp[${help.length}]:\n${help
    .map((hint) => `  ${hint}`)
    .join("\n")}`;
}

/** `--json` emits the normalized model with no renames and no re-nesting. */
export function renderStatusJson(report: StatusReport): string {
  return JSON.stringify(statusModel(report), null, 2);
}
