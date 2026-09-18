import { homedir } from "node:os";
import { encode } from "@toon-format/toon";
import type { ApplyReport } from "./apply.js";
import type { JournalRecord } from "./journal.js";
import { isReportOnlySurface } from "./surfaces/index.js";
import type { ToolStatus } from "./types.js";

export const SCHEMA_VERSION = 4;

/**
 * The delegate output a report shows by default before truncating with a
 * total-size marker (AXI: never omit, always show how much is missing).
 * `apply --full` lifts the cap.
 */
export const OUTPUT_PREVIEW_CHARS = 800;

/** Cap one `output[]` detail; the marker names the total so nothing is lost. */
export function truncateOutputDetail(detail: string, full?: boolean): string {
  if (full || detail.length <= OUTPUT_PREVIEW_CHARS) return detail;
  return `${detail.slice(0, OUTPUT_PREVIEW_CHARS)}… (truncated, ${detail.length} chars total)`;
}

/** The fields a `tools[]` row carries, in their default spelling. */
export const TOOL_ROW_FIELDS = [
  "surface",
  "tool",
  "installed",
  "version",
  "latest",
  "tier",
  "in_use",
  "apply",
  "pin",
] as const;

/** The fields a journal `records[]` row carries, in their default spelling. */
export const JOURNAL_ROW_FIELDS = [
  "id",
  "surface",
  "tool",
  "before",
  "after",
  "tier",
  "command",
  "exit",
  "duration_ms",
  "pin",
  "started_at",
] as const;

/** Project each row to the named fields, in the caller's order. */
function projectFields<Row extends Record<string, unknown>>(
  rows: Row[],
  fields?: string[],
): Row[] {
  if (!fields || fields.length === 0) return rows;
  return rows.map((row) => {
    const projected: Record<string, unknown> = {};
    for (const field of fields) projected[field] = row[field];
    // A projection of a row is still a row of the same block, partial.
    return projected as Row;
  });
}

/** Collapse the user's home directory to `~` for display. */
export function collapseHome(
  path: string,
  homeDir: string = homedir(),
): string {
  return path.startsWith(homeDir) ? `~${path.slice(homeDir.length)}` : path;
}

export interface StatusReport {
  generatedAt: string;
  schemaVersion: number;
  tools: ToolStatus[];
}

/** The row shape of the tools[] block; TOON and JSON share the spelling. */
type ToolRow = {
  surface: string;
  tool: string;
  installed: boolean;
  version?: string;
  latest?: string;
  tier?: string;
  in_use?: boolean;
  apply?: string;
  pin?: string;
};

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

interface OverlapRow {
  surface: string;
  tool: string;
  command: string;
  resolvedPath: string;
  otherPath: string;
}

interface SnapStateRow {
  surface: string;
  tool: string;
  channel?: string;
  revision?: string;
  available_revision?: string;
  held_until?: string;
  refresh_inhibited_until?: string;
}

/**
 * The sparse snap_state[] projection of row.snapState: the tracked channel
 * and revisions verbatim, and the hold facts mapped from snapd's documented
 * field shapes - `hold` and `gating-hold` are RFC3339 timestamps (the time
 * until which refreshes are held, the user hold shown when both exist), and
 * `refresh-inhibit` is an object carrying `proceed-time`. A value whose
 * shape snapd does not document stays absent - a hold is never an error and
 * never a gap, and the verbatim value remains on row.snapState.
 */
function toSnapStateRow(row: ToolStatus): SnapStateRow {
  const state = row.snapState;
  return {
    surface: row.surface,
    tool: row.tool,
    channel: state?.channel,
    revision: state?.revision,
    available_revision: state?.availableRevision,
    held_until: holdTimestamp(state?.hold) ?? holdTimestamp(state?.gatingHold),
    refresh_inhibited_until: proceedTime(state?.refreshInhibit),
  };
}

/** A documented hold timestamp, verbatim; any other shape stays absent. */
function holdTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The proceed-time of a documented refresh-inhibit object, verbatim. */
function proceedTime(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return holdTimestamp((value as { "proceed-time"?: unknown })["proceed-time"]);
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
  overlap?: OverlapRow[];
  snap_state?: SnapStateRow[];
  announce?: AnnounceRow[];
  in_use?: InUseRow[];
  sync?: SyncRow[];
  summary?: Record<string, number>;
}

export interface StatusModelOptions {
  /** Project every `tools[]` row to these fields (the `--fields` flag). */
  fields?: string[];
}

/**
 * The normalized model behind both renderers: sparse facts (probe failures,
 * PATH skew, announcements) live in their own blocks joined on surface+tool,
 * never inlined into every row.
 */
export function statusModel(
  report: StatusReport,
  options: StatusModelOptions = {},
): StatusModel {
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
  const overlapRows = report.tools.flatMap((row) =>
    (row.overlap ?? []).map((overlap) => ({
      surface: row.surface,
      tool: row.tool,
      command: overlap.command,
      resolvedPath: overlap.resolvedPath,
      otherPath: overlap.otherPath,
    })),
  );
  if (overlapRows.length > 0) model.overlap = overlapRows;
  const stateRows = report.tools.filter((row) => row.snapState);
  if (stateRows.length > 0) {
    model.snap_state = stateRows.map(toSnapStateRow);
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
  model.summary = statusSummary(model);
  // Projection happens last: the summary always counts the full rows.
  model.tools = projectFields(model.tools, options.fields);
  return model;
}

/**
 * Pre-computed counts the next step almost always needs: totals, gaps by
 * tier, in-use conflicts, and skew. Only known gaps count; an unknown
 * latest is never a gap, and a zero fact stays absent.
 */
function statusSummary(model: StatusModel): Record<string, number> {
  const summary: Record<string, number> = {
    tools: model.tools.length,
    gaps: model.tools.filter((row) => row.tier && row.tier !== "none").length,
  };
  for (const tier of ["major", "minor", "patch"] as const) {
    const count = model.tools.filter((row) => row.tier === tier).length;
    if (count > 0) summary[tier] = count;
  }
  const inUse = model.tools.filter((row) => row.in_use === true).length;
  if (inUse > 0) summary.in_use = inUse;
  if (model.skew && model.skew.length > 0) summary.skew = model.skew.length;
  return summary;
}

/** Options shared by the TOON renderers that can print a help block. */
export interface ToonOptions {
  /** Help lines used when the report carries no rows. */
  emptyHelp?: string[];
  /** Help lines appended whatever the report carries. */
  extraHelp?: string[];
}

export interface StatusRenderOptions extends StatusModelOptions, ToonOptions {
  /** The caller scoped with `--surface`: drop the scoping hint. */
  scoped?: boolean;
  /** The one surface requested, when `--surface` named exactly one. */
  singleSurface?: string;
}

/**
 * Help derived from the invocation and the rows: the scoping hint only
 * when unscoped, the apply hint only when known gaps exist that apply can
 * plan. A report-only surface's gaps hint the row's own command instead.
 */
function statusHelpHints(
  rows: ToolStatus[],
  options: { scoped?: boolean; singleSurface?: string },
): string[] {
  const hints: string[] = [];
  const gaps = rows.filter((row) => row.tier && row.tier !== "none");
  if (options.singleSurface && isReportOnlySurface(options.singleSurface)) {
    const commands = new Set(
      gaps.flatMap((row) => (row.applyCommand ? [row.applyCommand] : [])),
    );
    for (const command of commands) {
      hints.push(
        `Run \`${command}\` yourself: ${options.singleSurface} is report-only`,
      );
    }
  } else if (options.singleSurface) {
    if (gaps.length > 0) {
      hints.push(
        `Run \`upkeep-axi apply ${options.singleSurface}\` to plan its gaps`,
      );
    }
  } else if (gaps.some((row) => !isReportOnlySurface(row.surface))) {
    hints.push(
      "Run `upkeep-axi apply --all --tier <patch|minor|major>` to plan every gap at or below the tier",
    );
  }
  if (!options.scoped) {
    hints.push(
      "Run `upkeep-axi status --surface <id>` to scope to one surface",
    );
  }
  hints.push("Run `upkeep-axi status --json` for the normalized model");
  return hints;
}

/** Default output: compact TOON, decision-shaped, with a help block. */
export function renderStatusToon(
  report: StatusReport,
  binPath: string,
  description: string,
  options: StatusRenderOptions = {},
): string {
  const body: Record<string, unknown> = {
    bin: collapseHome(binPath),
    description,
    ...statusModel(report, options),
  };
  let help: string[];
  if (report.tools.length > 0) {
    help = statusHelpHints(report.tools, {
      scoped: options.scoped,
      singleSurface: options.singleSurface,
    });
  } else {
    help = options.emptyHelp ?? [
      "Run `upkeep-axi status --surface <id>` to scope to one surface",
      "Every configured surface is missing or disabled; check the config file",
    ];
  }
  help.push(...(options.extraHelp ?? []));
  return `${encode(body)}\nhelp[${help.length}]:\n${help
    .map((hint) => `  ${hint}`)
    .join("\n")}`;
}

/** `--json` emits the normalized model with no renames and no re-nesting. */
export function renderStatusJson(
  report: StatusReport,
  options: StatusModelOptions = {},
): string {
  return JSON.stringify(statusModel(report, options), null, 2);
}

const PLAN_HELP = [
  "Run `upkeep-axi apply ... --execute` to run this plan; nothing has run yet",
  "Run `upkeep-axi apply --all --tier <patch|minor|major>` to plan every gap at or below the tier",
];

const EXECUTED_HELP = [
  "Run `upkeep-axi journal` for the append-only record of what ran",
  "Run `upkeep-axi status --since <record id>` to report only what changed",
];

export interface ApplyRenderOptions {
  /** Lift the `output[]` display cap: print delegate output verbatim. */
  full?: boolean;
  /** Help lines used when the plan carried nothing to apply. */
  emptyPlanHelp?: string[];
}

/** The apply report: the plan, what was refused, and with --execute what ran. */
export function applyModel(
  report: ApplyReport,
  options: ApplyRenderOptions = {},
): Record<string, unknown> {
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
    model.output = report.output.map((row) => ({
      surface: row.surface,
      tool: row.tool,
      detail: truncateOutputDetail(row.detail, options.full),
    }));
  }
  if (report.results && report.results.length > 0) {
    const summary: Record<string, number> = {};
    for (const outcome of ["applied", "refused", "unconfirmed"] as const) {
      const count = report.results.filter(
        (row) => row.outcome === outcome,
      ).length;
      if (count > 0) summary[outcome] = count;
    }
    model.summary = summary;
  }
  return model;
}

export function renderApplyToon(
  report: ApplyReport,
  binPath: string,
  description: string,
  options: ApplyRenderOptions = {},
): string {
  const body = {
    bin: collapseHome(binPath),
    description,
    ...applyModel(report, options),
  };
  const help: string[] = [];
  if (report.plan.length === 0) {
    help.push(
      ...(options.emptyPlanHelp ?? [
        "Nothing to apply: no known gaps",
        "Run `upkeep-axi status` to see every surface and its apply commands",
      ]),
    );
  } else if (report.mode === "executed") {
    if (report.results?.some((row) => row.outcome !== "applied")) {
      help.push(
        "Exit is 1: every row is in results with its outcome; refused and unconfirmed delegates were not applied",
      );
    }
    if (
      !options.full &&
      report.output?.some(
        (row) => truncateOutputDetail(row.detail) !== row.detail,
      )
    ) {
      help.push(
        "Some delegate output was truncated: run the same apply with --full to print it verbatim",
      );
    }
    help.push(...EXECUTED_HELP);
  } else {
    help.push(...PLAN_HELP);
  }
  return `${encode(body)}\nhelp[${help.length}]:\n${help
    .map((hint) => `  ${hint}`)
    .join("\n")}`;
}

export function renderApplyJson(
  report: ApplyReport,
  options: ApplyRenderOptions = {},
): string {
  return JSON.stringify(applyModel(report, options), null, 2);
}

export interface JournalReport {
  generatedAt: string;
  schemaVersion: number;
  records: JournalRecord[];
}

export interface JournalRenderOptions {
  /** Project every record row to these fields (the `--fields` flag). */
  fields?: string[];
}

function journalRows(
  report: JournalReport,
  options: JournalRenderOptions = {},
): Array<Record<string, unknown>> {
  const rows = report.records.map((record) => ({
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
  }));
  return projectFields(rows, options.fields);
}

export function renderJournalToon(
  report: JournalReport,
  binPath: string,
  description: string,
  options: JournalRenderOptions = {},
): string {
  const body = {
    bin: collapseHome(binPath),
    description,
    generatedAt: report.generatedAt,
    schemaVersion: report.schemaVersion,
    records: journalRows(report, options),
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

export function renderJournalJson(
  report: JournalReport,
  options: JournalRenderOptions = {},
): string {
  return JSON.stringify(
    {
      generatedAt: report.generatedAt,
      schemaVersion: report.schemaVersion,
      records: journalRows(report, options),
    },
    null,
    2,
  );
}
