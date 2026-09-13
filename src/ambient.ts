import { encode } from "@toon-format/toon";
import { recordKey, type JournalRecord } from "./journal.js";
import { collapseHome, SCHEMA_VERSION } from "./render.js";
import { tierBetween } from "./semver.js";
import type { StatusSnapshot } from "./snapshot.js";
import type { ToolStatus } from "./types.js";

/**
 * The session-start dashboard (AXI §7): only the rows an agent needs to
 * orient - known gaps and in-use conflicts - bounded to a few lines, with
 * the counts pre-computed so nobody recounts rows (AXI §4). Deep data stays
 * in `status`; this view never widens into apply/pin text.
 */

/** Hard cap on dashboard rows; the rest are named by a help hint. */
export const AMBIENT_MAX_ROWS = 8;

/** A snapshot older than this is called stale in the summary. */
export const SNAPSHOT_STALE_MS = 24 * 60 * 60 * 1000;

/** One dashboard row: the six facts that decide whether to care. */
interface AmbientRow {
  surface: string;
  tool: string;
  version?: string;
  latest?: string;
  tier?: string;
  in_use?: boolean;
}

export interface AmbientModel {
  generatedAt: string;
  schemaVersion: number;
  /** When the inventory this view reads was taken; absent without one. */
  snapshotAt?: string;
  /** Whole days since the snapshot, present once it passes a day old. */
  snapshotAgeDays?: number;
  /** One-line pre-computed summary, spelled identically in TOON and JSON. */
  ambient: string;
  /** Gap and in-use rows, most severe first, capped at AMBIENT_MAX_ROWS. */
  tools: AmbientRow[];
  /** Present only when the cap hid rows. */
  hidden?: number;
}

const TIER_RANK: Record<string, number> = { major: 3, minor: 2, patch: 1 };
const TIERS = ["major", "minor", "patch"] as const;

function isGap(row: ToolStatus): boolean {
  return row.tier === "patch" || row.tier === "minor" || row.tier === "major";
}

/**
 * The rows the dashboard shows: every known gap and every in-use conflict.
 * In-use outranks tier (the house rule), then tier severity, then registry
 * order - a stable sort over the order collectStatus produced.
 */
export function ambientRows(tools: ToolStatus[]): ToolStatus[] {
  return tools
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => isGap(row) || row.inUse === true)
    .sort(
      (a, b) =>
        Number(b.row.inUse === true) - Number(a.row.inUse === true) ||
        (TIER_RANK[b.row.tier as string] ?? 0) -
          (TIER_RANK[a.row.tier as string] ?? 0) ||
        a.index - b.index,
    )
    .map(({ row }) => row);
}

/** The pre-computed one-liner: counts of known gaps by tier, plus in use. */
export function ambientSummary(
  rows: ToolStatus[],
  failedProbes: number,
  staleDays?: number,
): string {
  const gaps = rows.filter(isGap);
  const inUse = rows.filter((row) => row.inUse === true);
  const notes: string[] = [];
  if (failedProbes > 0) {
    notes.push(`${failedProbes} probe${failedProbes === 1 ? "" : "s"} failed`);
  }
  if (staleDays !== undefined) {
    notes.push(`snapshot ${staleDays} day${staleDays === 1 ? "" : "s"} old`);
  }
  if (gaps.length === 0 && inUse.length === 0) {
    // A definitive empty state: zero is stated, not implied (AXI §5).
    return ["no known gaps; nothing in use", ...notes].join("; ");
  }
  const parts: string[] = [];
  if (gaps.length > 0) {
    const tierBits = TIERS.map(
      (tier) => [tier, gaps.filter((row) => row.tier === tier).length] as const,
    )
      .filter(([, count]) => count > 0)
      .map(([tier, count]) => `${count} ${tier}`);
    parts.push(
      `${gaps.length} gap${gaps.length === 1 ? "" : "s"} (${tierBits.join(", ")})`,
    );
  }
  // `0 in use` is a measured fact, not filler: the sources ran and found
  // nothing, so the count is stated even when it is zero.
  parts.push(`${inUse.length} in use`);
  return [parts.join(", "), ...notes].join("; ");
}

/**
 * The snapshot's rows brought up to date with the journal: an apply that
 * exited 0 after the snapshot was taken (`after` present) replaces the
 * row's version, and its tier is re-derived against the snapshot's latest.
 */
export function applyJournalToSnapshot(
  tools: ToolStatus[],
  records: JournalRecord[],
): ToolStatus[] {
  const applied = new Map<string, string | undefined>();
  for (const record of records) {
    if (record.after !== undefined)
      applied.set(recordKey(record), record.after);
  }
  return tools.map((row) => {
    if (!applied.has(recordKey(row))) return row;
    const version = applied.get(recordKey(row));
    return { ...row, version, tier: tierBetween(version, row.latest) };
  });
}

/** No inventory on disk yet: a definitive empty state naming the way in. */
export function emptyAmbientModel(generatedAt: string): AmbientModel {
  return {
    generatedAt,
    schemaVersion: SCHEMA_VERSION,
    ambient: "no inventory yet: run `upkeep-axi status`",
    tools: [],
  };
}

export function buildAmbientModel(
  snapshot: StatusSnapshot,
  recordsSinceSnapshot: JournalRecord[],
  generatedAt: string,
): AmbientModel {
  const tools = applyJournalToSnapshot(snapshot.tools, recordsSinceSnapshot);
  const rows = ambientRows(tools);
  const failedProbes = tools.filter((row) => row.error).length;
  const age =
    new Date(generatedAt).getTime() - new Date(snapshot.generatedAt).getTime();
  const staleDays =
    age >= SNAPSHOT_STALE_MS ? Math.floor(age / SNAPSHOT_STALE_MS) : undefined;
  const model: AmbientModel = {
    generatedAt,
    schemaVersion: SCHEMA_VERSION,
    snapshotAt: snapshot.generatedAt,
    ambient: ambientSummary(rows, failedProbes, staleDays),
    tools: rows.slice(0, AMBIENT_MAX_ROWS).map((row) => ({
      surface: row.surface,
      tool: row.tool,
      version: row.version,
      latest: row.latest,
      tier: row.tier,
      in_use: row.inUse,
    })),
  };
  if (staleDays !== undefined) model.snapshotAgeDays = staleDays;
  if (rows.length > AMBIENT_MAX_ROWS) {
    model.hidden = rows.length - AMBIENT_MAX_ROWS;
  }
  return model;
}

export function renderAmbientToon(
  model: AmbientModel,
  binPath: string,
  description: string,
  homeDir?: string,
): string {
  const body: Record<string, unknown> = {
    bin: collapseHome(binPath, homeDir),
    description,
    generatedAt: model.generatedAt,
    schemaVersion: model.schemaVersion,
    ambient: model.ambient,
  };
  if (model.snapshotAt !== undefined) body.snapshotAt = model.snapshotAt;
  if (model.snapshotAgeDays !== undefined) {
    body.snapshotAgeDays = model.snapshotAgeDays;
  }
  if (model.tools.length > 0) body.tools = model.tools;
  const help: string[] = [];
  if (model.snapshotAt === undefined) {
    help.push(
      "Run `upkeep-axi status` once to take the inventory this dashboard reads",
    );
  } else if (model.hidden) {
    help.push(
      `Showing ${model.tools.length} of ${model.tools.length + model.hidden} rows, most severe first; run \`upkeep-axi status\` for every row with its apply and pin commands`,
    );
  } else if (model.tools.length === 0) {
    help.push(
      "Nothing needs attention: run `upkeep-axi status` for the full inventory",
    );
  } else {
    help.push(
      "Run `upkeep-axi status` for the full inventory with apply and pin commands",
    );
  }
  if (model.snapshotAgeDays !== undefined) {
    help.push("Run `upkeep-axi status` to refresh the inventory");
  }
  help.push(
    "Run `upkeep-axi setup hooks` to show this dashboard at every agent session start",
  );
  return `${encode(body)}\nhelp[${help.length}]:\n${help
    .map((hint) => `  ${hint}`)
    .join("\n")}`;
}

export function renderAmbientJson(model: AmbientModel): string {
  return JSON.stringify(model, null, 2);
}
