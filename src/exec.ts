import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import type { ExecResult } from "./types.js";

/** Default bounded wait for a status probe. */
export const PROBE_TIMEOUT_MS = 10_000;

export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every copy of `command` across PATH, in PATH order. The first entry is the
 * copy a shell would resolve; a later entry with a newer version is PATH skew.
 */
export function pathCandidates(
  command: string,
  env: NodeJS.ProcessEnv,
): string[] {
  const dirs = (env.PATH ?? "").split(":").filter(Boolean);
  const found: string[] = [];
  for (const dir of dirs) {
    const candidate = join(dir, command);
    if (isExecutableFile(candidate)) found.push(candidate);
  }
  return found;
}

/**
 * Run `file` with fixed argv under a bounded wait.
 *
 * Status probes are read-only, so a probe that outruns the budget is killed;
 * the apply task's delegates get the opposite contract (never killed
 * mid-write, reported as unconfirmed) and must not route through here.
 */
export function runBounded(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: null,
        stdout,
        stderr,
        timedOut: false,
        spawnError: error.message,
      });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

/** Map with bounded concurrency, preserving input order in the result. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** The tool never runs as root; fail loudly before any probe. */
export function assertNotRoot(): void {
  const geteuid = (process as { geteuid?: () => number }).geteuid;
  const getuid = (process as { getuid?: () => number }).getuid;
  const euid = geteuid?.() ?? getuid?.();
  if (euid === 0) {
    throw new AxiError("upkeep-axi never runs as root", "PRIVILEGE_ERROR", [
      "Run `upkeep-axi` as the workstation user instead",
    ]);
  }
}
