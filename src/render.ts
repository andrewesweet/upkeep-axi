import { homedir } from "node:os";
import { encode } from "@toon-format/toon";
import type { ApplyReport } from "./apply.js";
import type { JournalRecord } from "./journal.js";
import type { ToolStatus } from "./types.js";

export const SCHEMA_VERSION = 3;

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
  in_use?: boolean;
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
    in_use: row.inUse,
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

interface InUseRow {
  surface: string;
  tool: string;
  detail: string;
}

interface SyncRow {
  surface: string;
  tool: string;
  class: string;
  fork_ahead: number;
  upstream_ahead: number;
  fork_repo?: string;
  files?: string[];
}

interface StatusModel {
  generatedAt: string;
  schemaVersion: number;
  tools: ToolRow[];
  errors?: ErrorRow[];
  skew?: SkewRow[];
  announce?: AnnounceRow[];
  in_use?: InUseRow[];
  sync?: SyncRow[];
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
  const inUse = report.tools.filter((row) => row.inUseDetail);
  if (inUse.length > 0) {
    model.in_use = inUse.map((row) => ({
      surface: row.surface,
      tool: row.tool,
      detail: row.inUseDetail as string,
    }));
  }
  const sync = report.tools.filter((row) => row.sync);
  if (sync.length > 0) {
    model.sync = sync.map((row) => ({
      surface: row.surface,
      tool: row.tool,
      class: row.sync?.class as string,
      fork_ahead: row.sync?.forkAhead as number,
      upstream_ahead: row.sync?.upstreamAhead as number,
      fork_repo: row.sync?.forkRepo,
      files: row.sync?.files,
    }));
  }
  return model;
}

const HELP_HINTS = [
  "Run `upkeep-axi status --surface <id>` to scope to one surface",
  "Run `upkeep-axi status --json` for the normalized model",
];

interface ToonOptions {
  /** Help lines used when the report carries no rows. */
  emptyHelp?: string[];
}

/** Default output: compact TOON, decision-shaped, with a help block. */
export function renderStatusToon(
  report: StatusReport,
  binPath: string,
  description: string,
  options: ToonOptions = {},
): string {
  const body: Record<string, unknown> = {
    bin: collapseHome(binPath),
    description,
    ...statusModel(report),
  };
  const help =
    report.tools.length > 0
      ? HELP_HINTS
      : (options.emptyHelp ?? [
          "Run `upkeep-axi status --surface <id>` to scope to one surface",
          "Every configured surface is missing or disabled; check the config file",
        ]);
  return `${encode(body)}\nhelp[${help.length}]:\n${help
    .map((hint) => `  ${hint}`)
    .join("\n")}`;
}

/** `--json` emits the normalized model with no renames and no re-nesting. */
export function renderStatusJson(report: StatusReport): string {
  return JSON.stringify(statusModel(report), null, 2);
}

const PLAN_HELP = [
  "Run `upkeep-axi apply ... --execute` to run this plan; nothing has run yet",
  "Run `upkeep-axi apply --all --tier <patch|minor|major>` to plan every gap at or below the tier",
];

const EXECUTED_HELP = [
  "Run `upkeep-axi journal` for the append-only record of what ran",
  "Run `upkeep-axi status --since <record id>` to report only what changed",
];

/** The apply report: the plan, what was refused, and with --execute what ran. */
export function applyModel(report: ApplyReport): Record<string, unknown> {
  const model: Record<string, unknown> = {
    generatedAt: report.generatedAt,
    schemaVersion: report.schemaVersion,
    mode: report.mode,
    plan: report.plan.map((row) => ({
      surface: row.surface,
      tool: row.tool,
      before: row.before,
      latest: row.latest,
      tier: row.tier,
      command: row.command,
      pin: row.pin,
    })),
  };
  if (report.skipped && report.skipped.length > 0) {
    model.skipped = report.skipped;
  }
  if (report.results) {
    model.results = report.results.map((row) => ({
      surface: row.surface,
      tool: row.tool,
      command: row.command,
      outcome: row.outcome,
      exit: row.exit,
      duration_ms: row.duration_ms,
      before: row.before,
      after: row.after,
      pin: row.pin,
    }));
  }
  if (report.output && report.output.length > 0) {
    model.output = report.output;
  }
  return model;
}

export function renderApplyToon(
  report: ApplyReport,
  binPath: string,
  description: string,
): string {
  const body = {
    bin: collapseHome(binPath),
    description,
    ...applyModel(report),
  };
  const help =
    report.mode === "executed"
      ? EXECUTED_HELP
      : report.plan.length > 0
        ? PLAN_HELP
        : [
            "Run `upkeep-axi status` to see every surface and its apply commands",
          ];
  return `${encode(body)}\nhelp[${help.length}]:\n${help
    .map((hint) => `  ${hint}`)
    .join("\n")}`;
}

export function renderApplyJson(report: ApplyReport): string {
  return JSON.stringify(applyModel(report), null, 2);
}

export interface JournalReport {
  generatedAt: string;
  schemaVersion: number;
  records: JournalRecord[];
}

export function renderJournalToon(
  report: JournalReport,
  binPath: string,
  description: string,
): string {
  const body = {
    bin: collapseHome(binPath),
    description,
    generatedAt: report.generatedAt,
    schemaVersion: report.schemaVersion,
    records: report.records.map((record) => ({
      id: record.id,
      surface: record.surface,
      tool: record.tool,
      before: record.before,
      after: record.after,
      tier: record.tier,
      command: record.command,
      exit: record.exit,
      duration_ms: record.duration_ms,
      pin: record.pin,
      started_at: record.started_at,
    })),
  };
  const help =
    report.records.length > 0
      ? [
          "Run `upkeep-axi status --since <record id>` to report only what changed",
        ]
      : [
          "The journal is empty: no apply has executed yet",
          "Run `upkeep-axi apply <surface> --execute` to make the first record",
        ];
  return `${encode(body)}\nhelp[${help.length}]:\n${help
    .map((hint) => `  ${hint}`)
    .join("\n")}`;
}

export function renderJournalJson(report: JournalReport): string {
  return JSON.stringify(
    {
      generatedAt: report.generatedAt,
      schemaVersion: report.schemaVersion,
      records: report.records,
    },
    null,
    2,
  );
}
