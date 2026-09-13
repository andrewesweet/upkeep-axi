import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultJournalPath } from "./journal.js";
import type { ToolStatus } from "./types.js";

/**
 * The last full inventory `status` produced, kept beside the journal so the
 * session-start dashboard can read it without probing anything. Only an
 * unfiltered `status` run writes it: a `--surface` subset is not the
 * inventory and must never pose as it.
 */
export interface StatusSnapshot {
  generatedAt: string;
  schemaVersion: number;
  tools: ToolStatus[];
}

export function defaultSnapshotPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(dirname(defaultJournalPath(env)), "status.json");
}

export function writeSnapshot(path: string, snapshot: StatusSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot));
}

/** A missing or unparseable snapshot is no snapshot. */
export function readSnapshot(path: string): StatusSnapshot | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as StatusSnapshot).generatedAt === "string" &&
      Array.isArray((parsed as StatusSnapshot).tools)
    ) {
      return parsed as StatusSnapshot;
    }
  } catch {
    // fall through: unparseable is no snapshot
  }
  return undefined;
}
