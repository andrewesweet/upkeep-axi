import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AxiError } from "axi-sdk-js";

/**
 * The apply journal: append-only JSON lines under the tool's state directory,
 * one record per surface per tool per apply, never rotated. The journal is
 * the evidence for retrospectives and the history behind `status --since`;
 * rollback is the pin command each record carries, not a subsystem.
 */
export interface JournalRecord {
  /** Record id: the 1-based line number it was appended at. The cursor
   * `status --since` accepts. Stable because the file is append-only. */
  id: number;
  surface: string;
  tool: string;
  /** Installed version measured when the apply was planned. */
  before?: string;
  /** Version re-measured after an applied delegate; absent when unknown. */
  after?: string;
  tier?: string;
  /** The delegate command as the plan displayed it. */
  command: string;
  /** Delegate exit code; null when the delegate refused to start or ran over budget. */
  exit: number | null;
  duration_ms: number;
  /** The vendor command that would pin the before version. */
  pin?: string;
  /** When the delegate was started (ISO 8601). */
  started_at: string;
}

export type NewJournalRecord = Omit<JournalRecord, "id">;

/** The journal lives under $XDG_STATE_HOME (default ~/.local/state). */
export function defaultJournalPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const xdg = env.XDG_STATE_HOME || join(env.HOME ?? homedir(), ".local/state");
  return join(xdg, "upkeep-axi", "journal.jsonl");
}

/**
 * Read the journal in append order. A missing file is an empty journal. A
 * line that does not parse is skipped but still consumes its line number, so
 * ids of surviving records stay the line numbers they were appended at.
 */
export function readJournal(path: string): JournalRecord[] {
  if (!existsSync(path)) return [];
  const records: JournalRecord[] = [];
  const lines = readFileSync(path, "utf-8").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<JournalRecord>;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        typeof parsed.surface !== "string" ||
        typeof parsed.tool !== "string"
      ) {
        continue;
      }
      records.push({ ...parsed, id: index + 1 } as JournalRecord);
    } catch {
      // Damaged line: skip, keep counting.
    }
  }
  return records;
}

/**
 * Append records, assigning each its id from the line number it lands on.
 * Single-writer by contract: upkeep-axi is the only writer of this file.
 */
export function appendJournal(
  path: string,
  records: NewJournalRecord[],
): JournalRecord[] {
  if (records.length === 0) return [];
  mkdirSync(dirname(path), { recursive: true });
  const existing = readJournal(path);
  let nextId = (existing.at(-1)?.id ?? 0) + 1;
  const written: JournalRecord[] = records.map((record) => ({
    ...record,
    id: nextId++,
  }));
  appendFileSync(
    path,
    written.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
  return written;
}

/** The cursor `status --since` accepts: a record id or an ISO timestamp. */
export type Cursor = { kind: "id"; id: number } | { kind: "time"; at: Date };

export function parseCursor(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): Cursor {
  if (/^\d+$/.test(raw)) {
    return { kind: "id", id: Number.parseInt(raw, 10) };
  }
  const at = new Date(raw);
  if (!Number.isNaN(at.getTime())) {
    return { kind: "time", at };
  }
  throw new AxiError(`Invalid --since cursor: ${raw}`, "VALIDATION_ERROR", [
    "Pass a journal record id (a number) or an ISO timestamp, or use --changed-only",
    `The journal is ${defaultJournalPath(env)}`,
  ]);
}

/** Records strictly after the cursor: id > cursor id, or started_at > time. */
export function recordsSince(
  records: JournalRecord[],
  cursor: Cursor,
): JournalRecord[] {
  return records.filter((record) => {
    if (cursor.kind === "id") return record.id > cursor.id;
    const started = new Date(record.started_at);
    return !Number.isNaN(started.getTime()) && started > cursor.at;
  });
}

/** The surface+tool identity a journal record speaks about. */
export function recordKey(
  record: Pick<JournalRecord, "surface" | "tool">,
): string {
  return `${record.surface}\u0000${record.tool}`;
}
