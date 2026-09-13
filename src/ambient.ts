import { encode } from "@toon-format/toon";
import { collapseHome, SCHEMA_VERSION } from "./render.js";
import type { ToolStatus } from "./types.js";

/**
 * The session-start dashboard (AXI §7): only the rows an agent needs to
 * orient - known gaps and in-use conflicts - bounded to a few lines, with
 * the counts pre-computed so nobody recounts rows (AXI §4). Deep data stays
 * in `status`; this view never widens into apply/pin text.
 */

/** Hard cap on dashboard rows; the rest are named by a help hint. */
export const AMBIENT_MAX_ROWS = 8;

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
): string {
  const gaps = rows.filter(isGap);
  const inUse = rows.filter((row) => row.inUse === true);
  const failed =
    failedProbes > 0
      ? `${failedProbes} probe${failedProbes === 1 ? "" : "s"} failed`
      : undefined;
  if (gaps.length === 0 && inUse.length === 0) {
    // A definitive empty state: zero is stated, not implied (AXI §5).
    return failed !== undefined
      ? `no known gaps; nothing in use; ${failed}`
      : "no known gaps; nothing in use";
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
  const base = parts.join(", ");
  return failed !== undefined ? `${base}; ${failed}` : base;
}

export function buildAmbientModel(
  tools: ToolStatus[],
  generatedAt: string,
): AmbientModel {
  const rows = ambientRows(tools);
  const failedProbes = tools.filter((row) => row.error).length;
  const model: AmbientModel = {
    generatedAt,
    schemaVersion: SCHEMA_VERSION,
    ambient: ambientSummary(rows, failedProbes),
    tools: rows.slice(0, AMBIENT_MAX_ROWS).map((row) => ({
      surface: row.surface,
      tool: row.tool,
      version: row.version,
      latest: row.latest,
      tier: row.tier,
      in_use: row.inUse,
    })),
  };
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
  if (model.tools.length > 0) body.tools = model.tools;
  const help: string[] = [];
  if (model.hidden) {
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
