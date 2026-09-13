import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLI_PATH,
  createEnv,
  installStandardFakes,
  runCli,
  type CliResult,
  type FakeEnv,
} from "./helpers.js";
import { AMBIENT_MAX_ROWS } from "../src/ambient.js";

function stdEnv(): FakeEnv {
  const env = createEnv();
  installStandardFakes(env);
  return env;
}

/** TOON quotes the summary string; compare on the unquoted value. */
function unquoted(text: string): string {
  return text.replace(/"/g, "");
}

/** Spawn the second entrypoint - the exact command the installed hook runs. */
function runHookEntrypoint(env: NodeJS.ProcessEnv): Promise<CliResult> {
  const entrypoint = join(dirname(CLI_PATH), "upkeep-axi-ambient.js");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint], {
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
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("ambient (the session-start dashboard)", () => {
  it("shows only gaps and in-use rows, most severe first, capped, with counts", async () => {
    const fake = stdEnv();
    const result = await runCli(["ambient"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const out = result.stdout;
    // Identity header, then the pre-computed summary (AXI §4).
    expect(out).toMatch(/^bin: .+dist\/bin\/upkeep-axi\.js\n/);
    // Standard fakes: 10 known gaps (3 major, 7 minor), nothing in use.
    expect(unquoted(out)).toContain(
      "ambient: 10 gaps (3 major, 7 minor), 0 in use",
    );
    // Rows are capped and carry only the six decision-bearing columns.
    expect(out).toContain(
      `tools[${AMBIENT_MAX_ROWS}]{surface,tool,version,latest,tier,in_use}:`,
    );
    // Majors first, registry order inside a tier; no apply/pin text.
    const rows = out.split("\n").filter((line) => line.startsWith("  "));
    expect(rows[0]).toBe("  npm,unparsable,dev,2026.09.0,major,false");
    expect(rows[1]).toBe("  mise,node,20.11.0,22.0.0,major,false");
    expect(rows[2]).toBe("  apt,ripgrep,14.1.1,15.0.0,major,false");
    // The cap hid rows: the help names the total and the way out (AXI §3, §9).
    expect(out).toContain(
      `Showing ${AMBIENT_MAX_ROWS} of 10 rows, most severe first`,
    );
    expect(out).toContain(
      "Showing 8 of 10 rows, most severe first; run `upkeep-axi status` for every row",
    );
    // The dashboard never widens into vendor commands.
    expect(out).not.toContain("npm install -g");
  });

  it("ranks in-use conflicts above every tier", async () => {
    const fake = stdEnv();
    fake.writeFake(
      "herdr",
      `if [ "$1" = "--version" ]; then
  echo "herdr 0.9.0"
  exit 0
fi
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  echo '{"result":{"agents":[{"agent":"tsc","agent_status":"working"}]}}'
  exit 0
fi
exit 1`,
    );
    const result = await runCli(["ambient"], fake.env());
    expect(result.code).toBe(0);
    const out = result.stdout;
    // typescript (minor) is in use through its tsc bin: it leads the rows,
    // ahead of the majors, and the summary names it.
    expect(unquoted(out)).toContain(
      "ambient: 10 gaps (3 major, 7 minor), 1 in use",
    );
    const rows = out.split("\n").filter((line) => line.startsWith("  "));
    expect(rows[0]).toBe("  npm,typescript,5.6.3,5.7.2,minor,true");
  });

  it("says nothing definitively when there are no gaps and nothing in use", async () => {
    const fake = createEnv();
    const result = await runCli(["ambient"], fake.env());
    expect(result.code).toBe(0);
    const out = result.stdout;
    expect(out).toContain("ambient: no known gaps; nothing in use");
    expect(out).not.toContain("tools[");
    expect(out).toContain(
      "Nothing needs attention: run `upkeep-axi status` for the full inventory",
    );
  });

  it("counts failed probes instead of hiding them", async () => {
    const fake = stdEnv();
    // npm is detected (on PATH) but its listing probe fails.
    fake.writeFake(
      "npm",
      `if [ "$1" = "ls" ]; then exit 7; fi
if [ "$1" = "view" ]; then echo "1.0.0"; exit 0; fi
exit 1`,
    );
    const result = await runCli(["ambient"], fake.env());
    expect(result.code).toBe(0);
    expect(unquoted(result.stdout)).toContain("; 1 probe failed");
  });

  it("emits the same model as --json", async () => {
    const fake = stdEnv();
    const result = await runCli(["ambient", "--json"], fake.env());
    expect(result.code).toBe(0);
    const model = JSON.parse(result.stdout) as {
      generatedAt: string;
      schemaVersion: number;
      ambient: string;
      tools: Array<Record<string, unknown>>;
      hidden?: number;
    };
    expect(model.schemaVersion).toBe(3);
    expect(model.ambient).toBe("10 gaps (3 major, 7 minor), 0 in use");
    expect(model.tools).toHaveLength(AMBIENT_MAX_ROWS);
    expect(model.hidden).toBe(2);
    expect(model.tools[0]).toEqual({
      surface: "npm",
      tool: "unparsable",
      version: "dev",
      latest: "2026.09.0",
      tier: "major",
      in_use: false,
    });
  });

  it("rejects stray positionals and unknown flags", async () => {
    const fake = stdEnv();
    for (const argv of [
      ["ambient", "npm"],
      ["ambient", "--surface", "npm"],
    ]) {
      const result = await runCli(argv, fake.env());
      expect(result.code).toBe(2);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^error: /);
    }
  });

  it("is what the installed hook entrypoint prints", async () => {
    const fake = stdEnv();
    const result = await runHookEntrypoint(fake.env());
    expect(result.code).toBe(0);
    expect(unquoted(result.stdout)).toContain(
      "ambient: 10 gaps (3 major, 7 minor), 0 in use",
    );
    // The hook never widens into the inventory's vendor commands.
    expect(result.stdout).not.toContain("npm install -g");
  });
});
