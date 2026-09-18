import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";
import { CLI_PATH, createEnv } from "./helpers.js";

/**
 * How far above the bare node floor the version path may sit: a relative
 * multiple, never an absolute millisecond budget. The report's measurement
 * (version 25-31 ms against a 22-25 ms floor, a ratio of about 1.4) passes
 * this with better than 2x margin, while a runaway import of the command
 * graph would blow far past it.
 */
const FAST_PATH_BUDGET = 3;

/** Spawns per measurement: one slow scheduling tick must not decide. */
const RUNS = 5;

interface TimedRun {
  ms: number;
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Spawn one node process and time it from launch to exit. */
function timeSpawn(args: string[], env: NodeJS.ProcessEnv): Promise<TimedRun> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ ms: performance.now() - started, stdout, stderr, code }),
    );
  });
}

describe("version fast path (AXI principle 10)", () => {
  // The fast path probes nothing, so an empty fake bin dir on PATH is
  // enough: no vendor executable is reachable by construction.
  const fake = createEnv();

  it("prints the bare version and exits 0 for -v, -V, and --version", async () => {
    for (const flag of ["-v", "-V", "--version"]) {
      const result = await timeSpawn([CLI_PATH, flag], fake.env());
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(`${VERSION}\n`);
    }
  });

  it("answers within a small multiple of the bare node floor", async () => {
    // Both measurements run in this same process, interleaved, and each
    // takes the minimum of a few runs so one slow scheduling tick cannot
    // fail CI.
    const floors: number[] = [];
    const versions: number[] = [];
    for (let run = 0; run < RUNS; run++) {
      const floor = await timeSpawn(["-e", "console.log(1)"], fake.env());
      expect(floor.code).toBe(0);
      floors.push(floor.ms);
      const version = await timeSpawn([CLI_PATH, "--version"], fake.env());
      expect(version.code).toBe(0);
      versions.push(version.ms);
    }
    const floor = Math.min(...floors);
    const version = Math.min(...versions);
    expect(version).toBeLessThan(floor * FAST_PATH_BUDGET);
  });
});
