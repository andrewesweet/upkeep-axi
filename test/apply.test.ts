import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createEnv,
  installStandardFakes,
  runCli,
  type FakeEnv,
} from "./helpers.js";

function stdEnv(): FakeEnv {
  const env = createEnv();
  installStandardFakes(env);
  return env;
}

function journalPath(env: FakeEnv): string {
  return join(env.xdgStateDir, "upkeep-axi", "journal.jsonl");
}

function readJournalRecords(env: FakeEnv): Array<Record<string, unknown>> {
  return readFileSync(journalPath(env), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForFile(path: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return existsSync(path);
}

describe("apply planning (no --execute)", () => {
  it("prints the plan and runs nothing", async () => {
    const fake = stdEnv();
    const result = await runCli(["apply", "npm", "--json"], fake.env());
    expect(result.code).toBe(0);
    const model = JSON.parse(result.stdout) as {
      mode: string;
      plan: Array<Record<string, unknown>>;
      results?: unknown;
    };
    expect(model.mode).toBe("plan");
    // Known gaps at or below the default major tier, in status row order.
    expect(model.plan.map((row) => row.tool)).toEqual([
      "typescript",
      "unparsable",
    ]);
    expect(model.plan[0]).toMatchObject({
      surface: "npm",
      before: "5.6.3",
      latest: "5.7.2",
      tier: "minor",
      command: "npm install -g typescript@latest",
      pin: "npm install -g typescript@5.6.3",
    });
    // Nothing ran: no delegate side effect, no journal.
    expect(model.results).toBeUndefined();
    expect(existsSync(join(fake.root, ".npm-state", "typescript"))).toBe(false);
    expect(existsSync(journalPath(fake))).toBe(false);

    // The TOON default spells the same plan for the same caller shape.
    const toon = await runCli(["apply", "npm"], fake.env());
    expect(toon.code).toBe(0);
    expect(toon.stdout).toContain("mode: plan");
    expect(toon.stdout).toContain(
      "  npm,typescript,5.6.3,5.7.2,minor,npm install -g typescript@latest,npm install -g typescript@5.6.3",
    );
    expect(toon.stdout).toContain("nothing has run yet");
    expect(toon.stdout).not.toContain("results[");
  });

  it("--all --tier minor takes every gap at or below minor and never apt", async () => {
    const fake = stdEnv();
    const result = await runCli(
      ["apply", "--all", "--tier", "minor", "--json"],
      fake.env(),
    );
    expect(result.code).toBe(0);
    const model = JSON.parse(result.stdout) as {
      mode: string;
      plan: Array<{ surface: string; tool: string; tier: string }>;
    };
    // npm typescript (minor), uv ruff, cargo bacon, bun critique, gh dash,
    // fnm node, codex codex - in registry order. The major gaps (mise node,
    // npm unparsable, apt ripgrep) stay out, and apt never plans.
    expect(model.plan).toMatchObject([
      { surface: "npm", tool: "typescript", tier: "minor" },
      { surface: "uv", tool: "ruff", tier: "minor" },
      { surface: "cargo", tool: "bacon", tier: "minor" },
      { surface: "bun", tool: "critique", tier: "minor" },
      { surface: "gh", tool: "dash", tier: "minor" },
      { surface: "fnm", tool: "node", tier: "minor" },
      { surface: "codex", tool: "codex", tier: "minor" },
    ]);
    expect(model.plan.some((row) => row.surface === "apt")).toBe(false);
    expect(model.plan.some((row) => row.surface === "mise")).toBe(false);
  });

  it("naming tools selects them whatever their tier", async () => {
    const fake = stdEnv();
    const result = await runCli(
      ["apply", "npm", "unparsable", "--json"],
      fake.env(),
    );
    expect(result.code).toBe(0);
    const model = JSON.parse(result.stdout) as {
      plan: Array<{ surface: string; tool: string }>;
    };
    // A major gap, selected because the captain pointed at it.
    expect(model.plan.map((row) => row.tool)).toEqual(["unparsable"]);
  });

  it("--tier without --all is a usage error", async () => {
    const fake = stdEnv();
    const result = await runCli(
      ["apply", "npm", "--tier", "patch", "--json"],
      fake.env(),
    );
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("`--tier` is only valid with `--all`");
  });

  it("an empty plan for a named surface says why", async () => {
    const fake = stdEnv();
    const result = await runCli(["apply", "skills", "--json"], fake.env());
    expect(result.code).toBe(0);
    const model = JSON.parse(result.stdout) as {
      plan: unknown[];
      skipped?: Array<{ surface: string; tool: string; reason: string }>;
    };
    expect(model.plan).toEqual([]);
    expect(model.skipped).toEqual([
      { surface: "skills", tool: "skills", reason: "no updates" },
    ]);
  });

  it("a named tool status does not report is a refusal", async () => {
    const fake = stdEnv();
    const result = await runCli(
      ["apply", "npm", "nosuch", "--json"],
      fake.env(),
    );
    expect(result.code).toBe(0);
    const model = JSON.parse(result.stdout) as {
      plan: unknown[];
      skipped?: Array<{ surface: string; tool: string; reason: string }>;
    };
    expect(model.plan).toEqual([]);
    expect(model.skipped).toEqual([
      {
        surface: "npm",
        tool: "nosuch",
        reason: "status does not report this tool",
      },
    ]);
  });
});

describe("apply --execute", () => {
  it("runs the delegate, records the after version, and journals the exact record", async () => {
    const fake = stdEnv();
    const result = await runCli(
      ["apply", "npm", "typescript", "--execute", "--json"],
      fake.env(),
    );
    expect(result.code).toBe(0);
    const model = JSON.parse(result.stdout) as {
      mode: string;
      results: Array<Record<string, unknown>>;
    };
    expect(model.mode).toBe("executed");
    expect(model.results).toHaveLength(1);
    expect(model.results[0]).toMatchObject({
      surface: "npm",
      tool: "typescript",
      outcome: "applied",
      exit: 0,
      command: "npm install -g typescript@latest",
      before: "5.6.3",
      after: "5.7.2",
      pin: "npm install -g typescript@5.6.3",
    });
    // The delegate really mutated the fake ecosystem: a fresh status now
    // measures 5.7.2 installed with no gap left.
    const status = await runCli(
      ["status", "--surface", "npm", "--json"],
      fake.env(),
    );
    const row = (
      JSON.parse(status.stdout) as {
        tools: Array<{
          tool: string;
          version?: string;
          latest?: string;
          tier?: string;
        }>;
      }
    ).tools.find((tool) => tool.tool === "typescript");
    expect(row).toMatchObject({
      version: "5.7.2",
      latest: "5.7.2",
      tier: "none",
    });

    // The journal carries the exact record, one JSON line, id from line number.
    const records = readJournalRecords(fake);
    expect(records).toHaveLength(1);
    const record = records[0] as Record<string, unknown>;
    expect(record).toMatchObject({
      id: 1,
      surface: "npm",
      tool: "typescript",
      before: "5.6.3",
      after: "5.7.2",
      tier: "minor",
      command: "npm install -g typescript@latest",
      exit: 0,
      pin: "npm install -g typescript@5.6.3",
    });
    expect(typeof record.duration_ms).toBe("number");
    expect(new Date(record.started_at as string).getTime()).not.toBeNaN();
  });

  it("reports a refusal verbatim, never retries, and journals the nonzero exit", async () => {
    const fake = stdEnv();
    fake.writeFake(
      "mise",
      `if [ "$1" = "ls" ]; then
  echo '{"node":[{"version":"20.11.0","installed":true}]}'
  exit 0
fi
if [ "$1" = "outdated" ]; then
  echo '{"node":{"name":"node","current":"20.11.0","latest":"22.0.0"}}'
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "2026.8.8 linux-x64 (2026-08-17)"
  exit 0
fi
if [ "$1" = "upgrade" ]; then
  echo ran >> "$HOME/.mise-upgrade-calls"
  echo "mise: upgrade refused: node is locked by the fixture" >&2
  exit 3
fi
exit 1`,
    );
    const result = await runCli(
      ["apply", "mise", "--execute", "--json"],
      fake.env(),
    );
    expect(result.code).toBe(0);
    const model = JSON.parse(result.stdout) as {
      results: Array<Record<string, unknown>>;
      output?: Array<{ surface: string; tool: string; detail: string }>;
    };
    expect(model.results).toHaveLength(1);
    expect(model.results[0]).toMatchObject({
      surface: "mise",
      tool: "node",
      outcome: "refused",
      exit: 3,
      before: "20.11.0",
    });
    expect(model.results[0].after).toBeUndefined();
    // The vendor's own words, verbatim, in the sparse output block.
    expect(model.output).toEqual([
      {
        surface: "mise",
        tool: "node",
        detail: "mise: upgrade refused: node is locked by the fixture",
      },
    ]);
    // Never retried: exactly one delegate invocation, one journal record.
    const calls = readFileSync(join(fake.root, ".mise-upgrade-calls"), "utf-8");
    expect(calls.split("\n").filter((line) => line.trim())).toHaveLength(1);
    const records = readJournalRecords(fake);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      surface: "mise",
      tool: "node",
      tier: "major",
      exit: 3,
      command: "mise upgrade node",
      pin: "mise use -g node@20.11.0",
    });
    expect((records[0] as Record<string, unknown>).after).toBeUndefined();
  });

  it("reports an over-budget delegate unconfirmed and leaves the process alone", async () => {
    const fake = stdEnv();
    fake.writeFake(
      "mise",
      `if [ "$1" = "ls" ]; then
  echo '{"node":[{"version":"20.11.0","installed":true}]}'
  exit 0
fi
if [ "$1" = "outdated" ]; then
  echo '{"node":{"name":"node","current":"20.11.0","latest":"22.0.0"}}'
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "2026.8.8 linux-x64 (2026-08-17)"
  exit 0
fi
if [ "$1" = "upgrade" ]; then
  i=0
  while test "$i" -lt 6000000; do
    i=$((i+1))
  done
  echo finished > "$HOME/.mise-upgrade-done"
  exit 0
fi
exit 1`,
    );
    fake.writeConfig({ surfaces: { mise: { applyTimeoutMs: 150 } } });
    const result = await runCli(
      ["apply", "mise", "--execute", "--json"],
      fake.env(),
    );
    expect(result.code).toBe(0);
    const model = JSON.parse(result.stdout) as {
      results: Array<Record<string, unknown>>;
    };
    expect(model.results).toHaveLength(1);
    expect(model.results[0]).toMatchObject({
      surface: "mise",
      tool: "node",
      outcome: "unconfirmed",
      exit: null,
    });
    // The journal says what is knowable: started, never confirmed.
    const records = readJournalRecords(fake);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      surface: "mise",
      tool: "node",
      exit: null,
    });
    // The delegate was never killed: it finishes its work after the CLI
    // reported and writes its own marker.
    const finished = await waitForFile(join(fake.root, ".mise-upgrade-done"));
    expect(finished).toBe(true);
  });

  it("refuses an in-use surface with the reason and runs nothing", async () => {
    const fake = stdEnv();
    fake.writeFake(
      "herdr",
      `if [ "$1" = "--version" ]; then
  echo "herdr 0.9.0"
  exit 0
fi
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  echo '{"result":{"agents":[{"agent":"claude","agent_status":"working"}]}}'
  exit 0
fi
exit 1`,
    );
    const result = await runCli(
      ["apply", "claude", "--execute", "--json"],
      fake.env(),
    );
    expect(result.code).toBe(0);
    const model = JSON.parse(result.stdout) as {
      plan: unknown[];
      results?: unknown[];
      skipped?: Array<{ surface: string; tool: string; reason: string }>;
    };
    expect(model.plan).toEqual([]);
    expect(model.results).toEqual([]);
    const claude = model.skipped?.find((row) => row.tool === "claude");
    expect(claude).toEqual({
      surface: "claude",
      tool: "claude",
      reason: "in use: herdr agent claude is active",
    });
    expect(existsSync(journalPath(fake))).toBe(false);
  });

  it("refuses an npm package whose bin is an active herdr agent", async () => {
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
    const result = await runCli(
      ["apply", "npm", "typescript", "--execute", "--json"],
      fake.env(),
    );
    expect(result.code).toBe(0);
    const model = JSON.parse(result.stdout) as {
      plan: unknown[];
      skipped?: Array<{ surface: string; tool: string; reason: string }>;
    };
    expect(model.plan).toEqual([]);
    expect(model.skipped).toEqual([
      {
        surface: "npm",
        tool: "typescript",
        reason: "in use: herdr agent tsc is active",
      },
    ]);
    expect(existsSync(journalPath(fake))).toBe(false);
  });
});

describe("in-use sources", () => {
  it("reads active no-mistakes runs and names them in status", async () => {
    const fake = stdEnv();
    fake.writeFake(
      "no-mistakes",
      `if [ "$1" = "--version" ]; then
  echo "no-mistakes version v1.72.0 (9fcc865) 2026-09-08T13:12:43Z"
  exit 0
fi
if [ "$1" = "runs" ]; then
  echo "runs[1]:"
  echo "  running    fm/upkeep-apply-journal  abc1234def5678  2026-09-13T12:00:00Z"
  exit 0
fi
if [ "$1" = "update" ]; then
  echo "no-mistakes fake updated"
  exit 0
fi
exit 1`,
    );
    const result = await runCli(
      ["status", "--surface", "claude", "--json"],
      fake.env(),
    );
    expect(result.code).toBe(0);
    const model = JSON.parse(result.stdout) as {
      tools: Array<{ tool: string; in_use?: boolean }>;
      in_use?: Array<{ surface: string; tool: string; detail: string }>;
    };
    const claude = model.tools.find((row) => row.tool === "claude");
    expect(claude?.in_use).toBe(true);
    expect(model.in_use?.[0]).toMatchObject({
      surface: "claude",
      tool: "claude",
      detail:
        "no-mistakes run fm/upkeep-apply-journal is running (drives claude)",
    });
  });

  it("reads the process table and refuses the apply with the pid", async () => {
    const fake = stdEnv();
    // A process whose /proc/<pid>/exe is the copy of codex on the fake PATH:
    // exactly the file an apply would replace. /bin/sleep copied under the
    // test root keeps the fake PATH fake while giving the exe a real inode.
    // The PATH entry is a symlink to it, as installer stubs and fnm links
    // are: /proc reports the resolved binary, and the match must still hold.
    copyFileSync("/usr/bin/sleep", join(fake.root, "codex-real"));
    chmodSync(join(fake.root, "codex-real"), 0o755);
    rmSync(join(fake.binDir, "codex"));
    symlinkSync(join(fake.root, "codex-real"), join(fake.binDir, "codex"));
    const sleeper = spawn(join(fake.binDir, "codex"), ["10"], {
      stdio: "ignore",
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const status = await runCli(
        ["status", "--surface", "codex", "--json"],
        fake.env(),
      );
      expect(status.code).toBe(0);
      const model = JSON.parse(status.stdout) as {
        tools: Array<{ tool: string; in_use?: boolean }>;
        in_use?: Array<{ surface: string; tool: string; detail: string }>;
      };
      expect(model.tools[0]?.in_use).toBe(true);
      expect(model.in_use?.[0]?.detail).toMatch(
        /^process \d+ runs .+\/codex-real$/,
      );

      const apply = await runCli(
        ["apply", "codex", "--execute", "--json"],
        fake.env(),
      );
      expect(apply.code).toBe(0);
      const applied = JSON.parse(apply.stdout) as {
        plan: unknown[];
        results?: unknown[];
        skipped?: Array<{ surface: string; tool: string; reason: string }>;
      };
      expect(applied.plan).toEqual([]);
      expect(applied.results).toEqual([]);
      expect(applied.skipped?.[0]?.reason).toMatch(
        /^in use: process \d+ runs /,
      );
      expect(existsSync(journalPath(fake))).toBe(false);
    } finally {
      sleeper.kill("SIGKILL");
    }
  });
});

describe("apply usage errors", () => {
  it("--all without --tier is refused", async () => {
    const fake = stdEnv();
    const result = await runCli(["apply", "--all"], fake.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "`--all` requires `--tier <patch|minor|major>`",
    );
  });

  it("apt apply is refused: apt is report-only", async () => {
    const fake = stdEnv();
    const result = await runCli(["apply", "apt"], fake.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("apt is report-only");
    expect(existsSync(journalPath(fake))).toBe(false);
  });

  it("bare apply names the two shapes", async () => {
    const fake = stdEnv();
    const result = await runCli(["apply"], fake.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("--all --tier <patch|minor|major>");
  });
});

describe("--all --tier minor --execute end to end", () => {
  it("applies what applies, reports refusals verbatim, journals every row", async () => {
    const fake = stdEnv();
    // The last delegate to run reports whether earlier surfaces were already
    // journaled when it started: an interrupted run loses at most one surface.
    fake.writeFake(
      "codex",
      `if [ "$1" = "--version" ]; then
  echo "codex-cli 0.154.0"
  exit 0
fi
if [ "$1" = "update" ]; then
  if test -f "$XDG_STATE_HOME/upkeep-axi/journal.jsonl"; then echo "journal already written"; fi
  exit 1
fi
exit 1`,
    );
    const result = await runCli(
      ["apply", "--all", "--tier", "minor", "--execute", "--json"],
      fake.env(),
    );
    expect(result.code).toBe(0);
    const model = JSON.parse(result.stdout) as {
      mode: string;
      results: Array<{
        surface: string;
        tool: string;
        outcome: string;
        exit: number | null;
        after?: string;
      }>;
      output?: Array<{ surface: string; tool: string; detail: string }>;
    };
    // Seven planned rows, each exactly once: the npm and gh delegates exit 0
    // on their fakes; every other vendor updater refuses (exit 1) and is
    // never retried.
    expect(model.results.map((row) => [row.surface, row.tool])).toEqual([
      ["npm", "typescript"],
      ["uv", "ruff"],
      ["cargo", "bacon"],
      ["bun", "critique"],
      ["gh", "dash"],
      ["fnm", "node"],
      ["codex", "codex"],
    ]);
    const applied = model.results.filter((row) => row.outcome === "applied");
    expect(applied.map((row) => row.tool)).toEqual(["typescript", "dash"]);
    // gh's fake answers upgrade with exit 0 but the extension stays at v1.1.0:
    // the update did not take effect, and the record says so in `after`.
    const dash = model.results.find((row) => row.tool === "dash");
    expect(dash).toMatchObject({ outcome: "applied", after: "v1.1.0" });
    // Every refusal is reported verbatim once.
    const ruff = model.output?.find((row) => row.surface === "uv");
    expect(ruff).toBeUndefined(); // the fake refuses silently: no output at all
    expect(model.output?.find((row) => row.surface === "codex")?.detail).toBe(
      "journal already written",
    );
    const records = readJournalRecords(fake);
    expect(records).toHaveLength(7);
    expect(records.map((record) => record.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // The npm delegate's mutation is real in the fake ecosystem.
    expect(
      readFileSync(join(fake.root, ".npm-state", "typescript"), "utf-8").trim(),
    ).toBe("5.7.2");
  });
});

describe("journal verb", () => {
  it("prints the records the applies wrote, in TOON and JSON", async () => {
    const fake = stdEnv();
    const empty = await runCli(["journal"], fake.env());
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("The journal is empty");

    await runCli(["apply", "npm", "typescript", "--execute"], fake.env());
    const toon = await runCli(["journal"], fake.env());
    expect(toon.code).toBe(0);
    expect(toon.stdout).toContain(
      "records[1]{id,surface,tool,before,after,tier,command,exit,duration_ms,pin,started_at}:",
    );
    expect(toon.stdout).toContain(
      "  1,npm,typescript,5.6.3,5.7.2,minor,npm install -g typescript@latest,0,",
    );
    const json = await runCli(["journal", "--json"], fake.env());
    const model = JSON.parse(json.stdout) as {
      records: Array<Record<string, unknown>>;
    };
    expect(model.records).toHaveLength(1);
    expect(model.records[0]).toMatchObject({
      id: 1,
      surface: "npm",
      tool: "typescript",
      exit: 0,
    });
  });
});

describe("status --since and --changed-only", () => {
  it("reports only what changed since the cursor", async () => {
    const fake = stdEnv();
    const apply = await runCli(
      ["apply", "npm", "typescript", "--execute", "--json"],
      fake.env(),
    );
    expect(apply.code).toBe(0);

    // --since 0 (before any record): the row the record names, nothing else.
    const sinceZero = await runCli(
      ["status", "--since", "0", "--json"],
      fake.env(),
    );
    expect(sinceZero.code).toBe(0);
    expect(
      (
        JSON.parse(sinceZero.stdout) as {
          tools: Array<{ surface: string; tool: string }>;
        }
      ).tools.map((row) => [row.surface, row.tool]),
    ).toEqual([["npm", "typescript"]]);

    // A cursor at the record itself reports nothing changed.
    const since = await runCli(
      ["status", "--since", "1", "--json"],
      fake.env(),
    );
    expect(since.code).toBe(0);
    expect((JSON.parse(since.stdout) as { tools: unknown[] }).tools).toEqual(
      [],
    );

    // A time cursor before the record reports exactly the row it names.
    const before = await runCli(
      ["status", "--since", "1970-01-01T00:00:00Z", "--json"],
      fake.env(),
    );
    expect(before.code).toBe(0);
    expect(
      (
        JSON.parse(before.stdout) as {
          tools: Array<{ surface: string; tool: string }>;
        }
      ).tools.map((row) => [row.surface, row.tool]),
    ).toEqual([["npm", "typescript"]]);

    // Right after the apply the installed version is the journal's `after`:
    // nothing drifted.
    const changed = await runCli(
      ["status", "--changed-only", "--json"],
      fake.env(),
    );
    expect(changed.code).toBe(0);
    expect((JSON.parse(changed.stdout) as { tools: unknown[] }).tools).toEqual(
      [],
    );

    // A change made outside upkeep-axi drifts the row from the journal's
    // last word on it, and only that row is reported.
    fake.writeFakeFile(".npm-state/typescript", "5.8.0\n");
    const drifted = await runCli(
      ["status", "--changed-only", "--json"],
      fake.env(),
    );
    expect(drifted.code).toBe(0);
    expect(
      (
        JSON.parse(drifted.stdout) as {
          tools: Array<{ surface: string; tool: string; version?: string }>;
        }
      ).tools.map((row) => [row.surface, row.tool, row.version]),
    ).toEqual([["npm", "typescript", "5.8.0"]]);
  });

  it("appends after a damaged last line and keeps ids as line numbers", async () => {
    const fake = stdEnv();
    fake.writeFakeFile(
      "xdg-state/upkeep-axi/journal.jsonl",
      '{"surface":"npm","tool":"left',
    );
    const apply = await runCli(
      ["apply", "npm", "typescript", "--execute", "--json"],
      fake.env(),
    );
    expect(apply.code).toBe(0);
    const lines = readFileSync(journalPath(fake), "utf-8").split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1])).toMatchObject({ id: 2, tool: "typescript" });
    const journal = await runCli(["journal", "--json"], fake.env());
    const model = JSON.parse(journal.stdout) as {
      records: Array<{ id: number }>;
    };
    expect(model.records.map((record) => record.id)).toEqual([2]);
  });

  it("--changed-only on an empty journal reports everything", async () => {
    const fake = stdEnv();
    const result = await runCli(["status", "--changed-only"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("tools[40]{");
  });

  it("a refused apply changes nothing and --since does not report it", async () => {
    const fake = stdEnv();
    const refused = await runCli(
      ["apply", "uv", "ruff", "--execute", "--json"],
      fake.env(),
    );
    expect(refused.code).toBe(0);
    expect(
      (JSON.parse(refused.stdout) as { results: Array<{ outcome: string }> })
        .results[0]?.outcome,
    ).toBe("refused");
    const since = await runCli(
      ["status", "--since", "0", "--json"],
      fake.env(),
    );
    expect(since.code).toBe(0);
    expect((JSON.parse(since.stdout) as { tools: unknown[] }).tools).toEqual(
      [],
    );
  });

  it("rejects an unparseable cursor", async () => {
    const fake = stdEnv();
    const result = await runCli(
      ["status", "--since", "not-a-date"],
      fake.env(),
    );
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("Invalid --since cursor");
  });
});
