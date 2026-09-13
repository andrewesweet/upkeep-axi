import { DEFAULT_APPLY_TIMEOUT_MS, runDelegate } from "./exec.js";
import {
  appendJournal,
  defaultJournalPath,
  type NewJournalRecord,
} from "./journal.js";
import { resolveSurfaces } from "./surfaces/index.js";
import { applyCommandText } from "./surfaces/shared.js";
import { collectStatus } from "./status.js";
import type {
  ApplyDelegate,
  SemverTier,
  Surface,
  SurfaceContext,
  UpkeepConfig,
} from "./types.js";

/** Tier rank for `--tier` selection: a lower rank includes the tighter tiers. */
const TIER_RANK: Record<Exclude<SemverTier, "none">, number> = {
  patch: 1,
  minor: 2,
  major: 3,
};

export type ApplyTier = keyof typeof TIER_RANK;

export function isApplyTier(value: string): value is ApplyTier {
  return value === "patch" || value === "minor" || value === "major";
}

/** One row the plan would apply. */
export interface PlanRow {
  surface: string;
  tool: string;
  before?: string;
  latest?: string;
  tier?: string;
  /** The delegate command as it will run, spelled once from the argv. */
  command: string;
  /** The vendor command that pins the before version (rollback copy-paste). */
  pin?: string;
  /** The delegate, resolved once at plan time and reused at execute time. */
  delegate: ApplyDelegate;
  timeoutMs: number;
  /** When execution started this delegate (ISO 8601); set by executePlan. */
  startedAt?: string;
}

/** One row the plan refuses, with the reason. */
export interface SkippedRow {
  surface: string;
  tool: string;
  reason: string;
}

export interface ApplyResultRow {
  surface: string;
  tool: string;
  command: string;
  outcome: "applied" | "refused" | "unconfirmed";
  exit: number | null;
  duration_ms: number;
  before?: string;
  /** Version re-measured after an applied delegate; absent when unknown. */
  after?: string;
  pin?: string;
}

/** Verbatim delegate output, surfaced for every outcome that printed. */
export interface DelegateOutputRow {
  surface: string;
  tool: string;
  detail: string;
}

export interface ApplyReport {
  generatedAt: string;
  schemaVersion: number;
  mode: "plan" | "executed";
  plan: PlanRow[];
  skipped?: SkippedRow[];
  results?: ApplyResultRow[];
  output?: DelegateOutputRow[];
}

/**
 * What the CLI parsed out of `apply`'s argv: either `--all --tier <t>` or a
 * named surface with optional named tools.
 */
export type ApplySelection =
  | { all: true; tier: ApplyTier }
  | { all: false; surface: string; tools: string[] };

/** The per-surface apply budget: config option, else the generous default. */
export function applyTimeoutFor(
  config: UpkeepConfig,
  surfaceId: string,
): number {
  return (
    config.surfaces?.[surfaceId]?.applyTimeoutMs ?? DEFAULT_APPLY_TIMEOUT_MS
  );
}

function ctxFor(
  config: UpkeepConfig,
  surface: Surface,
  env: NodeJS.ProcessEnv,
): SurfaceContext {
  const surfaceConfig = config.surfaces?.[surface.id] ?? {};
  return {
    config,
    surface: surfaceConfig,
    env,
    // Delegates never route through here; this exec exists only so the
    // context satisfies the shared contract.
    exec: () => {
      throw new Error("apply planning never probes");
    },
  };
}

/**
 * Build the plan from the same rows `status` produces, in registry order.
 *
 * Selection: `--all --tier T` takes every row with a known gap at or below
 * T across all surfaces (apt never plans - report-only). Naming a surface
 * takes its rows with any known gap. Naming tools takes exactly those rows
 * whatever their tier: the captain pointed at them. Rows that are not
 * installed, have no delegate, or are measured in use are refused with the
 * reason instead of planned.
 */
export async function buildPlan(
  config: UpkeepConfig,
  selection: ApplySelection,
  env: NodeJS.ProcessEnv,
): Promise<{ plan: PlanRow[]; skipped: SkippedRow[] }> {
  const maxRank = selection.all ? TIER_RANK[selection.tier] : Infinity;
  const surfaces = resolveSurfaces(
    selection.all ? undefined : [selection.surface],
  );
  const rows = await collectStatus(config, surfaces, env);
  const surfaceById = new Map(surfaces.map((surface) => [surface.id, surface]));
  const namedSurface = selection.all ? undefined : selection.surface;
  const namedTools =
    !selection.all && selection.tools.length > 0
      ? new Map(selection.tools.map((tool) => [tool, false]))
      : undefined;

  const plan: PlanRow[] = [];
  const skipped: SkippedRow[] = [];
  const planned = new Set<string>();
  const knownRow = new Set<string>();

  for (const row of rows) {
    knownRow.add(`${row.surface}\u0000${row.tool}`);
    if (namedTools?.has(row.tool) && row.surface === namedSurface) {
      namedTools.set(row.tool, true);
    }
    const explicit =
      namedTools?.has(row.tool) === true && row.surface === namedSurface;
    if (!row.installed) {
      if (explicit) {
        skipped.push({
          surface: row.surface,
          tool: row.tool,
          reason: "not installed",
        });
      }
      continue;
    }
    const surface = surfaceById.get(row.surface);
    if (!surface) continue;
    const delegate = surface.apply(ctxFor(config, surface, env), row);
    if (!delegate) {
      // A row that knows why it cannot be applied reports that reason
      // wherever the caller asked for it (a named surface, a named tool, or
      // --all): a conflicting sync stops and names its files. Other
      // delegate-less rows stay silent unless the caller named them.
      if (explicit || row.refusal) {
        skipped.push({
          surface: row.surface,
          tool: row.tool,
          reason:
            row.refusal ??
            "the surface publishes no apply command for this tool",
        });
      }
      continue;
    }
    // In use is a safety refusal, not a tier fact: it comes before the
    // tier filter so a tool with no latest still refuses with the reason.
    if (row.inUse) {
      skipped.push({
        surface: row.surface,
        tool: row.tool,
        reason: `in use: ${row.inUseDetail ?? "a source names it"}`,
      });
      continue;
    }
    // Tier filter: a known gap at or below the selected tier. Explicitly
    // named tools were already selected by the captain pointing at them,
    // and they are the only rows a tool-named selection plans.
    if (!explicit) {
      if (namedTools) continue;
      if (!row.tier || row.tier === "none") continue;
      if (TIER_RANK[row.tier as ApplyTier] > maxRank) continue;
    }
    const key = `${row.surface}\u0000${row.tool}`;
    if (planned.has(key)) continue;
    planned.add(key);
    plan.push({
      surface: row.surface,
      tool: row.tool,
      before: row.version,
      latest: row.latest,
      tier: row.tier,
      command: applyCommandText(delegate),
      pin: row.pinCommand,
      delegate,
      timeoutMs: applyTimeoutFor(config, row.surface),
    });
  }

  // A named tool status never reported is a refusal, not a silence.
  if (namedTools) {
    for (const [tool, seen] of namedTools) {
      if (!seen && !knownRow.has(`${namedSurface}\u0000${tool}`)) {
        skipped.push({
          surface: namedSurface as string,
          tool,
          reason: "status does not report this tool",
        });
      }
    }
  }
  // A named surface that contributed nothing says so in the skipped block.
  if (namedSurface !== undefined && plan.length === 0 && skipped.length === 0) {
    const surface = surfaceById.get(namedSurface);
    const managerRow = rows.find(
      (row) =>
        row.surface === namedSurface && row.tool === surface?.managerTool,
    );
    skipped.push({
      surface: namedSurface,
      tool: surface?.managerTool ?? namedSurface,
      reason:
        managerRow && !managerRow.installed
          ? "the surface's manager is not installed"
          : "no updates",
    });
  }
  return { plan, skipped };
}

/**
 * Execute a plan: one delegate at a time, in plan order, each under its own
 * budget. The plan is grouped by surface (registry order keeps a surface's
 * rows contiguous): after a surface's delegates ran, that surface is
 * re-probed so an applied row records the version now installed - `after`
 * equal to `before` makes a no-effect update visible - and its records are
 * journaled at once, before the next surface starts. An interrupted run
 * loses at most the surface it was in.
 */
export async function executePlan(
  config: UpkeepConfig,
  plan: PlanRow[],
  env: NodeJS.ProcessEnv,
): Promise<{ results: ApplyResultRow[]; output: DelegateOutputRow[] }> {
  const results: ApplyResultRow[] = [];
  const output: DelegateOutputRow[] = [];
  const journalPath = defaultJournalPath(env);
  for (const surfaceId of new Set(plan.map((row) => row.surface))) {
    const rows = plan.filter((row) => row.surface === surfaceId);
    const surfaceResults: ApplyResultRow[] = [];
    for (const row of rows) {
      row.startedAt = new Date().toISOString();
      const outcome = await runDelegate(row.delegate.steps, env, row.timeoutMs);
      surfaceResults.push({
        surface: row.surface,
        tool: row.tool,
        command: row.command,
        outcome: outcome.outcome,
        exit: outcome.code,
        duration_ms: outcome.durationMs,
        before: row.before,
        pin: row.pin,
      });
      if (outcome.output.trim()) {
        output.push({
          surface: row.surface,
          tool: row.tool,
          detail: outcome.output.trim(),
        });
      }
    }
    // A refused or unconfirmed row keeps after absent.
    if (surfaceResults.some((result) => result.outcome === "applied")) {
      const fresh = await collectStatus(
        config,
        resolveSurfaces([surfaceId]),
        env,
      );
      for (const result of surfaceResults) {
        if (result.outcome !== "applied") continue;
        result.after = fresh.find(
          (row) => row.surface === result.surface && row.tool === result.tool,
        )?.version;
      }
    }
    const records: NewJournalRecord[] = rows.map((row, index) => ({
      surface: row.surface,
      tool: row.tool,
      before: row.before,
      after: surfaceResults[index].after,
      tier: row.tier,
      command: row.command,
      exit: surfaceResults[index].exit,
      duration_ms: surfaceResults[index].duration_ms,
      pin: row.pin,
      started_at: row.startedAt as string,
    }));
    appendJournal(journalPath, records);
    results.push(...surfaceResults);
  }
  return { results, output };
}
