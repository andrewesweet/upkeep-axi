import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InUseProber, markInUse } from "../src/inuse.js";
import type { ToolStatus } from "../src/types.js";
import { createEnv, type FakeEnv } from "./helpers.js";

/**
 * The in-use process matcher runs in-process, so these are unit tests, not
 * CLI spawns: no surface carries executable roots yet (the snap surface
 * supplies them when it lands), and the matcher is the piece under test.
 * The running-process technique is the existing one from the apply suite:
 * a copy of /usr/bin/sleep gives the spawned process a real inode without
 * touching any real executable.
 */

/** A harmless long-running process under a fake snap-style mount path. */
function snapSleeper(env: FakeEnv): string {
  const exe = join(env.root, "snap/firefox/8929/usr/lib/firefox/firefox");
  mkdirSync(dirname(exe), { recursive: true });
  copyFileSync("/usr/bin/sleep", exe);
  chmodSync(exe, 0o755);
  return exe;
}

async function untilProcessAppears(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
}

/**
 * The exclusion driver: spawned from a copy of the node binary placed under
 * the declared root, so the prober's own /proc/<pid>/exe lies under the
 * prefix. It starts a sleeper (its child, not its ancestor), probes, and
 * prints its own pid plus the facts as one JSON line.
 */
const DRIVER_SOURCE = `
const { spawn } = await import("node:child_process");
const { InUseProber } = await import(${JSON.stringify(fileURLToPath(new URL("../dist/src/inuse.js", import.meta.url)))});
const [sleeper, root] = process.argv.slice(1);
const child = spawn(sleeper, ["60"], { stdio: "ignore" });
await new Promise((resolve) => setTimeout(resolve, 300));
const facts = await new InUseProber({ PATH: "" }).factsFor([], [root]);
child.kill("SIGKILL");
console.log(JSON.stringify({ pid: process.pid, facts }));
`;

describe("in-use executable roots", () => {
  it("matches a process running under a declared executable root", async () => {
    const env = createEnv();
    const exe = snapSleeper(env);
    const prober = new InUseProber(env.env());
    const sleeper = spawn(exe, ["60"], { stdio: "ignore" });
    try {
      await untilProcessAppears();
      // No `firefox` exists on the fake PATH - like /snap/bin/firefox
      // resolving to the generic launcher, exact matching cannot see the
      // running image; only the declared root can.
      const facts = await prober.factsFor(
        ["firefox"],
        [join(env.root, "snap/firefox")],
      );
      expect(facts).toEqual([
        { source: "process", detail: `process ${sleeper.pid} runs ${exe}` },
      ]);
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("does not match for a row without a covering root", async () => {
    const env = createEnv();
    const exe = snapSleeper(env);
    const prober = new InUseProber(env.env());
    const sleeper = spawn(exe, ["60"], { stdio: "ignore" });
    try {
      await untilProcessAppears();
      // No roots declared: exact matching only, and nothing named on PATH.
      expect(await prober.factsFor(["firefox"], [])).toEqual([]);
      // A root is a directory boundary: /snap/fire/ is not /snap/firefox/.
      expect(await prober.factsFor([], [join(env.root, "snap/fire")])).toEqual(
        [],
      );
      expect(await prober.factsFor([], [join(env.root, "snap/other")])).toEqual(
        [],
      );
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("marks a root-carrying row in use and a rootless row clear", async () => {
    const env = createEnv();
    const exe = snapSleeper(env);
    const prober = new InUseProber(env.env());
    const sleeper = spawn(exe, ["60"], { stdio: "ignore" });
    try {
      await untilProcessAppears();
      const rows: ToolStatus[] = [
        {
          surface: "snap",
          tool: "firefox",
          installed: true,
          applyCommand: "sudo snap refresh firefox",
          executableRoots: [join(env.root, "snap/firefox")],
        },
        {
          surface: "snap",
          tool: "firefox",
          installed: true,
          applyCommand: "sudo snap refresh firefox",
        },
      ];
      await markInUse({}, rows, prober);
      expect(rows[0]?.inUse).toBe(true);
      expect(rows[0]?.inUseDetail).toBe(`process ${sleeper.pid} runs ${exe}`);
      expect(rows[1]?.inUse).toBe(false);
      expect(rows[1]?.inUseDetail).toBeUndefined();
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("never reports the prober's own process tree under a declared root", async () => {
    const env = createEnv();
    const exe = snapSleeper(env);
    // The driver runs from a copy of this suite's node binary under the
    // prefix: its own exe lies under the declared root, but it is the
    // prober's own process, so the self/ancestor exclusion must keep it
    // out while its child sleeper is still reported.
    const driverNode = join(env.root, "snap/firefox/8929/usr/bin/node");
    mkdirSync(dirname(driverNode), { recursive: true });
    try {
      linkSync(process.execPath, driverNode);
    } catch {
      // Cross-device: fall back to a copy of the same inode's content.
      copyFileSync(process.execPath, driverNode);
    }
    chmodSync(driverNode, 0o755);
    const driver = spawn(
      driverNode,
      [
        "--input-type=module",
        "-e",
        DRIVER_SOURCE,
        exe,
        join(env.root, "snap/firefox"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    driver.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      driver.on("error", reject);
      driver.on("close", resolve);
    });
    expect(code).toBe(0);
    const report = JSON.parse(stdout) as {
      pid: number;
      facts: Array<{ detail: string }>;
    };
    expect(report.facts).toHaveLength(1);
    expect(report.facts[0]?.detail).toContain(exe);
    // The driver's own exe sits under the root; it must not be the fact.
    expect(report.facts[0]?.detail).not.toContain(driverNode);
    expect(String(report.pid)).not.toBe(
      report.facts[0]?.detail.match(/^process (\d+) /)?.[1],
    );
  });

  it("reports one fact when an exact match and a root hit one process", async () => {
    const env = createEnv();
    const exe = snapSleeper(env);
    symlinkSync(exe, join(env.binDir, "myexe"));
    const prober = new InUseProber(env.env());
    const sleeper = spawn(join(env.binDir, "myexe"), ["60"], {
      stdio: "ignore",
    });
    try {
      await untilProcessAppears();
      const facts = await prober.factsFor(
        ["myexe"],
        [join(env.root, "snap/firefox")],
      );
      expect(facts).toEqual([
        { source: "process", detail: `process ${sleeper.pid} runs ${exe}` },
      ]);
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("reads a row clear when every source is missing or empty", async () => {
    const env = createEnv();
    const prober = new InUseProber(env.env());
    const rows: ToolStatus[] = [
      {
        surface: "snap",
        tool: "firefox",
        installed: true,
        applyCommand: "sudo snap refresh firefox",
        executableRoots: [join(env.root, "snap/firefox")],
      },
    ];
    // herdr and no-mistakes are absent from the fake PATH, and no process
    // runs under the root: a missing source contributes nothing, and the
    // measured-clear row reads false - never absent, never true.
    await markInUse({}, rows, prober);
    expect(rows[0]?.inUse).toBe(false);
    expect(rows[0]?.inUseDetail).toBeUndefined();
  });
});
