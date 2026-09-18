import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  linkSync,
  rmSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  collapseInUseDetail,
  InUseProber,
  markInUse,
  type InUseFact,
} from "../src/inuse.js";
import { snapSurface } from "../src/surfaces/snap.js";
import type { ToolStatus } from "../src/types.js";
import { createEnv, startSnapdFixture, type FakeEnv } from "./helpers.js";

/**
 * The in-use process matcher runs in-process, so these are unit tests, not
 * CLI spawns: the matcher is the piece under test, and the snap surface's
 * rows (which declare the executable roots) enter only through its status.
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
      await markInUse({ id: "snap", managerTool: "snap" }, rows, prober);
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
      chmodSync(driverNode, 0o755);
    }
    try {
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
    } finally {
      rmSync(driverNode, { force: true });
    }
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

  it("snap rows ignore the launcher and same-name PATH copies; only the root marks in use", async () => {
    const env = createEnv();
    // /snap/bin/firefox is a symlink to the generic snapd launcher: a
    // launcher-shaped process on PATH must not claim the firefox row.
    const launcher = join(env.root, "usr/lib/snapd/snap");
    mkdirSync(dirname(launcher), { recursive: true });
    copyFileSync("/usr/bin/sleep", launcher);
    chmodSync(launcher, 0o755);
    symlinkSync(launcher, join(env.binDir, "firefox"));
    const fixture = await startSnapdFixture(env.root);
    const rowsFromSurface = async (): Promise<ToolStatus[]> => {
      fixture.queue(
        { ok: { version: "2.76.3", "snap-mount-dir": join(env.root, "snap") } },
        {
          ok: [
            {
              name: "firefox",
              status: "active",
              type: "app",
              version: "154.0.1-1",
              revision: "8929",
              apps: [{ name: "firefox" }],
            },
          ],
        },
        { ok: [] },
      );
      return snapSurface.status({
        config: { surfaces: { snap: { socketPath: fixture.socketPath } } },
        surface: { socketPath: fixture.socketPath },
        env: env.env(),
        exec: async () => ({
          code: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
        }),
      });
    };
    try {
      const launcherProcess = spawn(join(env.binDir, "firefox"), ["60"], {
        stdio: "ignore",
      });
      try {
        await untilProcessAppears();
        const rows = await rowsFromSurface();
        expect(rows.map((row) => row.tool)).toEqual(["firefox"]);
        await markInUse(snapSurface, rows, new InUseProber(env.env()));
        expect(rows[0]?.inUse).toBe(false);
        expect(rows[0]?.inUseDetail).toBeUndefined();
      } finally {
        launcherProcess.kill("SIGKILL");
      }
      const exe = snapSleeper(env);
      const imageProcess = spawn(exe, ["60"], { stdio: "ignore" });
      try {
        await untilProcessAppears();
        const rows = await rowsFromSurface();
        await markInUse(snapSurface, rows, new InUseProber(env.env()));
        expect(rows[0]?.inUse).toBe(true);
        expect(rows[0]?.inUseDetail).toBe(
          `process ${imageProcess.pid} runs ${exe}`,
        );
      } finally {
        imageProcess.kill("SIGKILL");
      }
    } finally {
      await fixture.close();
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
    await markInUse({ id: "snap", managerTool: "snap" }, rows, prober);
    expect(rows[0]?.inUse).toBe(false);
    expect(rows[0]?.inUseDetail).toBeUndefined();
  });
});

/**
 * A minimal surface in the claude/pi shape: every row's apply replaces the
 * manager binary unless the row declares its own executables.
 */
function sharedExecutableSurface() {
  return {
    id: "testsurface",
    managerTool: "testtool",
    replacedExecutables: (row: ToolStatus) => row.executables ?? ["testtool"],
  };
}

/** A prober that counts factsFor calls, to pin the per-key memoisation. */
function countingProber(env: NodeJS.ProcessEnv): {
  prober: InUseProber;
  calls(): number;
} {
  const prober = new InUseProber(env);
  let calls = 0;
  const inner = prober.factsFor.bind(prober);
  Object.defineProperty(prober, "factsFor", {
    value: (executables: string[], roots?: string[]): Promise<InUseFact[]> => {
      calls += 1;
      return inner(executables, roots);
    },
  });
  return { prober, calls: () => calls };
}

describe("in-use fact collapse", () => {
  it("references the manager row when a row measures the same fact set", async () => {
    const env = createEnv();
    const exe = join(env.root, "lib/testtool-real");
    mkdirSync(dirname(exe), { recursive: true });
    copyFileSync("/usr/bin/sleep", exe);
    chmodSync(exe, 0o755);
    symlinkSync(exe, join(env.binDir, "testtool"));
    const prober = new InUseProber(env.env());
    const sleeper = spawn(join(env.binDir, "testtool"), ["60"], {
      stdio: "ignore",
    });
    try {
      await untilProcessAppears();
      const rows: ToolStatus[] = [
        {
          surface: "testsurface",
          tool: "testtool",
          installed: true,
          applyCommand: "testtool update",
        },
        {
          surface: "testsurface",
          tool: "plugin@official",
          installed: true,
          applyCommand: "testtool plugin update plugin@official",
          executables: ["testtool"],
        },
        {
          surface: "testsurface",
          tool: "marketplace",
          installed: true,
          applyCommand: "testtool marketplace update marketplace",
          executables: ["testtool"],
        },
        {
          surface: "testsurface",
          tool: "quiet",
          installed: true,
          applyCommand: "quiet update",
          executables: ["quietexe"],
        },
      ];
      await markInUse(sharedExecutableSurface(), rows, prober);
      collapseInUseDetail(rows, [sharedExecutableSurface()]);
      // The manager row states the fact; rows measuring the same set
      // reference it instead of repeating it; a row measuring nothing
      // stays clear.
      expect(rows[0]?.inUse).toBe(true);
      expect(rows[0]?.inUseDetail).toBe(`process ${sleeper.pid} runs ${exe}`);
      expect(rows[1]?.inUseDetail).toBe("same as testsurface,testtool");
      expect(rows[2]?.inUseDetail).toBe("same as testsurface,testtool");
      expect(rows[3]?.inUse).toBe(false);
      expect(rows[3]?.inUseDetail).toBeUndefined();
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("keeps the full detail when the manager row is not among the emitted rows", async () => {
    const env = createEnv();
    const exe = join(env.root, "lib/testtool-real");
    mkdirSync(dirname(exe), { recursive: true });
    copyFileSync("/usr/bin/sleep", exe);
    chmodSync(exe, 0o755);
    symlinkSync(exe, join(env.binDir, "testtool"));
    const prober = new InUseProber(env.env());
    const sleeper = spawn(join(env.binDir, "testtool"), ["60"], {
      stdio: "ignore",
    });
    try {
      await untilProcessAppears();
      const rows: ToolStatus[] = [
        {
          surface: "testsurface",
          tool: "testtool",
          installed: true,
          applyCommand: "testtool update",
        },
        {
          surface: "testsurface",
          tool: "plugin@official",
          installed: true,
          applyCommand: "testtool plugin update plugin@official",
        },
      ];
      await markInUse(sharedExecutableSurface(), rows, prober);
      // A filter dropped the manager row: the plugin row has no referent,
      // so it states the fact itself.
      const emitted = rows.filter((row) => row.tool !== "testtool");
      collapseInUseDetail(emitted, [sharedExecutableSurface()]);
      expect(emitted[0]?.inUseDetail).toBe(
        `process ${sleeper.pid} runs ${exe}`,
      );
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("keeps the full detail when a row measures a different set", async () => {
    const env = createEnv();
    const managerExe = join(env.root, "lib/testtool-real");
    const workerExe = join(env.root, "lib/worker-real");
    mkdirSync(dirname(managerExe), { recursive: true });
    copyFileSync("/usr/bin/sleep", managerExe);
    copyFileSync("/usr/bin/sleep", workerExe);
    chmodSync(managerExe, 0o755);
    chmodSync(workerExe, 0o755);
    symlinkSync(managerExe, join(env.binDir, "testtool"));
    symlinkSync(workerExe, join(env.binDir, "workerexe"));
    const prober = new InUseProber(env.env());
    const managerSleeper = spawn(join(env.binDir, "testtool"), ["60"], {
      stdio: "ignore",
    });
    const workerSleeper = spawn(join(env.binDir, "workerexe"), ["60"], {
      stdio: "ignore",
    });
    try {
      await untilProcessAppears();
      const rows: ToolStatus[] = [
        {
          surface: "testsurface",
          tool: "testtool",
          installed: true,
          applyCommand: "testtool update",
        },
        {
          surface: "testsurface",
          tool: "worker",
          installed: true,
          applyCommand: "worker update",
          executables: ["workerexe"],
        },
      ];
      await markInUse(sharedExecutableSurface(), rows, prober);
      collapseInUseDetail(rows, [sharedExecutableSurface()]);
      expect(rows[0]?.inUseDetail).toBe(
        `process ${managerSleeper.pid} runs ${managerExe}`,
      );
      // Different facts: the row keeps its own; no manager reference.
      expect(rows[1]?.inUseDetail).toBe(
        `process ${workerSleeper.pid} runs ${workerExe}`,
      );
    } finally {
      managerSleeper.kill("SIGKILL");
      workerSleeper.kill("SIGKILL");
    }
  });

  it("never references a manager row that measures clear", async () => {
    const env = createEnv();
    const exe = join(env.root, "lib/worker-real");
    mkdirSync(dirname(exe), { recursive: true });
    copyFileSync("/usr/bin/sleep", exe);
    chmodSync(exe, 0o755);
    symlinkSync(exe, join(env.binDir, "workerexe"));
    const prober = new InUseProber(env.env());
    const sleeper = spawn(join(env.binDir, "workerexe"), ["60"], {
      stdio: "ignore",
    });
    try {
      await untilProcessAppears();
      const rows: ToolStatus[] = [
        {
          surface: "testsurface",
          tool: "testtool",
          installed: true,
          applyCommand: "testtool update",
        },
        {
          surface: "testsurface",
          tool: "worker",
          installed: true,
          applyCommand: "worker update",
          executables: ["workerexe"],
        },
      ];
      await markInUse(sharedExecutableSurface(), rows, prober);
      collapseInUseDetail(rows, [sharedExecutableSurface()]);
      // The manager measures clear, so there is nothing to reference: the
      // in-use row states its own fact in full.
      expect(rows[0]?.inUse).toBe(false);
      expect(rows[1]?.inUseDetail).toBe(`process ${sleeper.pid} runs ${exe}`);
    } finally {
      sleeper.kill("SIGKILL");
    }
  });

  it("measures once per executables/roots key, not once per row", async () => {
    const env = createEnv();
    const rows: ToolStatus[] = [
      {
        surface: "testsurface",
        tool: "testtool",
        installed: true,
        applyCommand: "testtool update",
      },
      {
        surface: "testsurface",
        tool: "plugin@official",
        installed: true,
        applyCommand: "testtool plugin update plugin@official",
        executables: ["testtool"],
      },
      {
        surface: "testsurface",
        tool: "marketplace",
        installed: true,
        applyCommand: "testtool marketplace update marketplace",
        executables: ["testtool"],
      },
      {
        surface: "testsurface",
        tool: "quiet",
        installed: true,
        applyCommand: "quiet update",
        executables: ["quietexe"],
      },
    ];
    const { prober, calls } = countingProber(env.env());
    await markInUse(sharedExecutableSurface(), rows, prober);
    // One shared key (manager, plugin, marketplace) and one own key.
    expect(calls()).toBe(2);
    // Nothing runs on this host: every row still reads clear, not absent.
    expect(rows.map((row) => row.inUse)).toEqual([false, false, false, false]);
  });
});
