import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import type { ApplyStep, ExecResult } from "./types.js";

/** Default bounded wait for a status probe. */
export const PROBE_TIMEOUT_MS = 10_000;

/** Default budget for one apply delegate run; generous by design. */
export const DEFAULT_APPLY_TIMEOUT_MS = 900_000;

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
 * apply delegates get the opposite contract (never killed mid-write, reported
 * as unconfirmed) and must not route through here.
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

export interface DelegateOutcome {
  outcome: "applied" | "refused" | "unconfirmed";
  /** Exit code of the failing or last step; null on spawn failure or timeout. */
  code: number | null;
  durationMs: number;
  /** The delegate's own output at the point it stopped, verbatim. */
  output: string;
}

interface StepWait {
  kind: "close" | "timeout" | "error";
  code?: number | null;
  signal?: NodeJS.Signals | null;
  message?: string;
}

/**
 * Run one delegate step with output captured into temp files - never pipes,
 * so an over-budget child can keep writing after the CLI is gone without
 * ever seeing a broken pipe. On timeout the child is left running: it is
 * unref'd, never signalled, and its partial output is read as a snapshot.
 */
function runDelegateStep(
  step: ApplyStep,
  env: NodeJS.ProcessEnv,
  budgetMs: number,
): Promise<{ wait: StepWait; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), "upkeep-axi-delegate-"));
    const outPath = join(dir, "out");
    const errPath = join(dir, "err");
    const outFd = openSync(outPath, "w");
    const errFd = openSync(errPath, "w");
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(step.file, step.args, {
        env,
        stdio: ["ignore", outFd, errFd],
      });
    } catch (error) {
      closeSync(outFd);
      closeSync(errFd);
      rmSync(dir, { recursive: true, force: true });
      resolve({
        wait: {
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        },
        stdout: "",
        stderr: "",
      });
      return;
    }
    // The child holds its own copies of the fds; the parent needs none.
    closeSync(outFd);
    closeSync(errFd);
    let settled = false;
    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        // Never kill mid-write: detach and report unconfirmed.
        child.unref();
        resolve({
          wait: { kind: "timeout" },
          stdout: readTemp(outPath),
          stderr: readTemp(errPath),
        });
      },
      Math.max(budgetMs, 1),
    );
    // The capture directory is removed once the child is gone; on timeout
    // it stays, because the detached child is still writing into it.
    const finish = (wait: StepWait) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = readTemp(outPath);
      const stderr = readTemp(errPath);
      rmSync(dir, { recursive: true, force: true });
      resolve({ wait, stdout, stderr });
    };
    child.on("error", (error) =>
      finish({ kind: "error", message: error.message }),
    );
    child.on("close", (code, signal) =>
      finish({ kind: "close", code, signal }),
    );
  });
}

/** Snapshot a temp capture file; a not-yet-created file reads empty. */
function readTemp(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Run a delegate: the surface module's fixed steps, sequentially with `&&`
 * semantics, under one time budget.
 *
 * A step that exits nonzero means the vendor's own updater refused: the
 * output is reported verbatim and nothing is retried. A step still running
 * at the budget is left running - never killed mid-write - and the delegate
 * is reported unconfirmed; its later steps do not run.
 */
export async function runDelegate(
  steps: ApplyStep[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number = DEFAULT_APPLY_TIMEOUT_MS,
): Promise<DelegateOutcome> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const remaining = deadline - Date.now();
    const { wait, stdout, stderr } = await runDelegateStep(
      step,
      env,
      remaining,
    );
    const output = `${stdout}${stderr}`;
    const durationMs = Date.now() - started;
    if (wait.kind === "timeout") {
      return { outcome: "unconfirmed", code: null, durationMs, output };
    }
    if (wait.kind === "error") {
      return {
        outcome: "refused",
        code: null,
        durationMs,
        output: output || (wait.message ?? "could not be started"),
      };
    }
    if (wait.code !== 0) {
      return {
        outcome: "refused",
        code: wait.code ?? null,
        durationMs,
        output,
      };
    }
  }
  return {
    outcome: "applied",
    code: 0,
    durationMs: Date.now() - started,
    output: "",
  };
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
