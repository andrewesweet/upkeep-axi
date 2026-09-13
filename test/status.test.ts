import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLI_PATH,
  createEnv,
  installStandardFakes,
  runCli,
  writeRawConfig,
  type FakeEnv,
} from "./helpers.js";

function stdEnv(): FakeEnv {
  const env = createEnv();
  installStandardFakes(env);
  return env;
}

describe("status (TOON default)", () => {
  it("reports installed, latest, tier, apply and pin for every surface in registry order", async () => {
    const fake = stdEnv();
    const result = await runCli(["status"], fake.env());
    expect(result.code).toBe(0);
    const out = result.stdout;
    // Home header identifies the tool (AXI).
    expect(out).toMatch(/^bin: .+dist\/bin\/upkeep-axi\.js\n/);
    expect(out).toContain(
      "description: Report workstation update inventory across surfaces.",
    );
    expect(out).toContain("generatedAt: ");
    // One row per tool, fixed columns: 5 npm + 3 mise + 2 uv.
    expect(out).toContain(
      "tools[10]{surface,tool,installed,version,latest,tier,apply,pin}:",
    );
    // npm rows: tier none, minor, unparseable-as-major, and unknown latest.
    expect(out).toContain(
      "  npm,left-pad,true,1.3.0,1.3.0,none,npm install -g left-pad@latest,npm install -g left-pad@1.3.0",
    );
    expect(out).toContain(
      "  npm,typescript,true,5.6.3,5.7.2,minor,npm install -g typescript@latest,npm install -g typescript@5.6.3",
    );
    // An unparseable gap is major, never casual.
    expect(out).toContain(
      "  npm,unparsable,true,dev,2026.09.0,major,npm install -g unparsable@latest,npm install -g unparsable@dev",
    );
    // A failed latest read stays absent: no latest, no tier.
    expect(out).toContain(
      "  npm,gone,true,2.0.0,null,null,npm install -g gone@latest,npm install -g gone@2.0.0",
    );
    // mise reports itself plus managed tools; a configured-not-installed
    // entry reports installed=false.
    expect(out).toContain(
      "  mise,mise,true,2026.8.8,null,null,mise self-update,mise self-update 2026.8.8",
    );
    expect(out).toContain(
      "  mise,node,true,20.11.0,22.0.0,major,mise upgrade node,mise use -g node@20.11.0",
    );
    expect(out).toContain("  mise,ghost,false,null,null,null,null,null");
    // A configured-not-installed mise entry reports only its absence.
    expect(out).toContain("  mise,ghost,false,null,null,null,null,null");
    // uv tools with and without a known update.
    expect(out).toContain(
      "  uv,ruff,true,0.3.4,0.9.0,minor,uv tool upgrade ruff,uv tool install ruff==0.3.4",
    );
    expect(out).toContain(
      "  uv,zizmor,true,1.24.1,null,null,uv tool upgrade zizmor,uv tool install zizmor==1.24.1",
    );
    expect(out).toContain(
      "  mise,mise,true,2026.8.8,null,null,mise self-update,mise self-update 2026.8.8",
    );
    expect(out).toContain(
      "  mise,node,true,20.11.0,22.0.0,major,mise upgrade node,mise use -g node@20.11.0",
    );
    // Registry order: all npm rows before mise rows before uv rows.
    expect(out.indexOf("  npm,")).toBeLessThan(out.indexOf("  mise,"));
    expect(out.indexOf("  mise,")).toBeLessThan(out.indexOf("  uv,"));
    // Sparse blocks stay absent when there is nothing to report.
    expect(out).not.toContain("skew[");
    expect(out).not.toContain("announce[");
    expect(out).not.toContain("errors[");
    // Contextual help.
    expect(out).toContain("help[2]:");
    expect(out).toContain(
      "Run `upkeep-axi status --json` for the normalized model",
    );
  });

  it("bare invocation behaves like status", async () => {
    const fake = stdEnv();
    const result = await runCli([], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "tools[10]{surface,tool,installed,version,latest,tier,apply,pin}:",
    );
  });

  it("omits a disabled surface and honors --surface scoping", async () => {
    const fake = stdEnv();
    fake.writeConfig({ surfaces: { uv: { enabled: false } } });
    const all = await runCli(["status"], fake.env());
    expect(all.code).toBe(0);
    expect(all.stdout).not.toContain("  uv,");
    expect(all.stdout).toContain(
      "tools[8]{surface,tool,installed,version,latest,tier,apply,pin}:",
    );
    const scoped = await runCli(
      ["status", "--surface", "npm,mise"],
      fake.env(),
    );
    expect(scoped.code).toBe(0);
    expect(scoped.stdout).toContain(
      "tools[8]{surface,tool,installed,version,latest,tier,apply,pin}:",
    );
    expect(scoped.stdout).not.toContain("  uv,");
  });

  it("keeps registry order whatever the --surface spelling", async () => {
    const fake = stdEnv();
    const result = await runCli(["status", "--surface", "uv,npm"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("  mise,");
    expect(result.stdout.indexOf("  npm,")).toBeLessThan(
      result.stdout.indexOf("  uv,"),
    );
  });

  it("collapses several installed mise versions to the active one with a global pin", async () => {
    const env = createEnv();
    env.writeFake(
      "mise",
      `if [ "$1" = "ls" ]; then
  echo '{"jq":[{"version":"1.8.1","installed":true,"active":false},{"version":"1.8.2","installed":true,"active":true},{"version":"1.9.0","installed":true,"active":false}],"just":[{"version":"1.57.0","installed":true,"active":false},{"version":"1.58.0","installed":true,"active":false}]}'
  exit 0
fi
if [ "$1" = "outdated" ]; then
  echo '{"jq":{"name":"jq","current":"1.8.2","latest":"1.8.3"}}'
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "2026.8.8"
  exit 0
fi
exit 1`,
    );
    const result = await runCli(["status", "--surface", "mise"], env.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "tools[3]{surface,tool,installed,version,latest,tier,apply,pin}:",
    );
    expect(result.stdout).toContain(
      "  mise,jq,true,1.8.2,1.8.3,patch,mise upgrade jq,mise use -g jq@1.8.2",
    );
    expect(result.stdout).toContain(
      "  mise,just,true,1.58.0,null,null,mise upgrade just,mise use -g just@1.58.0",
    );
  });

  it("reports an installed version newer than latest as tier none", async () => {
    const env = createEnv();
    env.writeFake(
      "npm",
      `if [ "$1" = "ls" ]; then
  echo '{"dependencies":{"ahead":{"version":"6.0.0-beta.1"}}}'
  exit 0
fi
if [ "$1" = "view" ]; then
  echo "5.9.3"
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "10.9.0"
  exit 0
fi
exit 1`,
    );
    const result = await runCli(["status", "--surface", "npm"], env.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "  npm,ahead,true,6.0.0-beta.1,5.9.3,none,",
    );
  });

  it("reports a missing manager as one not-installed row", async () => {
    const bare = createEnv();
    bare.writeFake("npm", "exit 0");
    const missing = await runCli(["status", "--surface", "mise"], bare.env());
    expect(missing.code).toBe(0);
    expect(missing.stdout).toContain(
      "tools[1]{surface,tool,installed,version,latest,tier,apply,pin}:",
    );
    expect(missing.stdout).toContain(
      "  mise,mise,false,null,null,null,null,null",
    );
  });

  it("reports a failed manager inventory verbatim in the errors block", async () => {
    const fake = createEnv();
    fake.writeFake(
      "mise",
      `if [ "$1" = "ls" ]; then
  echo "mise fake: registry exploded" >&2
  exit 3
fi
if [ "$1" = "--version" ]; then
  echo "2026.8.8 linux-x64"
  exit 0
fi
exit 1`,
    );
    const result = await runCli(["status", "--surface", "mise"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("errors[1]{surface,tool,detail}:");
    expect(result.stdout).toContain("mise,mise,mise ls --json failed (exit 3)");
    expect(result.stdout).toContain(
      "  mise,mise,true,2026.8.8,null,null,null,null",
    );
  });
});

describe("PATH skew and announcements", () => {
  function skewEnv(): { fake: FakeEnv; older: string; newer: string } {
    const fake = stdEnv();
    const older = join(fake.root, "older");
    const newer = join(fake.root, "newer");
    fake.writeFakeIn(older, "fakecli", 'echo "fakecli 1.0.0"');
    fake.writeFakeIn(newer, "fakecli", 'echo "fakecli 2.0.0"');
    fake.writeConfig({
      surfaces: {
        npm: {
          tools: [
            {
              name: "esbuild",
              command: "fakecli",
              version_args: ["--version"],
              announce_args: ["--help"],
              announce_pattern:
                "fakecli would like to tell you: [^ ]+ -> [^ ]+",
            },
          ],
        },
      },
    });
    return { fake, older, newer };
  }

  function envWithSkew(fake: FakeEnv, older: string, newer: string) {
    return {
      PATH: `${fake.binDir}:${older}:${newer}`,
      HOME: fake.root,
      XDG_CONFIG_HOME: fake.xdgDir,
    };
  }

  it("measures a newer copy behind the resolved one as update not in effect", async () => {
    const { fake, older, newer } = skewEnv();
    const result = await runCli(
      ["status", "--surface", "npm"],
      envWithSkew(fake, older, newer),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "skew[1]{surface,tool,command,resolvedPath,resolvedVersion,newerPath,newerVersion}:",
    );
    const skewRow = result.stdout
      .split("\n")
      .find((line) => line.includes(`${older}/fakecli`));
    expect(skewRow).toBeDefined();
    expect(skewRow).toContain(
      `npm,esbuild,fakecli,${older}/fakecli,1.0.0,${newer}/fakecli,2.0.0`,
    );
  });

  it("reports the tool's own announcement as its claim", async () => {
    const fake = stdEnv();
    fake.writeFake(
      "toolcli",
      `if [ "$1" = "--help" ]; then
  echo "toolcli 5.6.3"
  echo "A new version of typescript is available: 5.6.3 -> 5.7.2"
  exit 0
fi
exit 1`,
    );
    fake.writeConfig({
      surfaces: {
        npm: {
          tools: [
            {
              name: "typescript",
              command: "toolcli",
              announce_args: ["--help"],
              announce_pattern:
                "A new version of typescript is available: [^ ]+ -> [^ ]+",
            },
          ],
        },
      },
    });
    const result = await runCli(["status", "--surface", "npm"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("announce[1]{surface,tool,claim}:");
    expect(result.stdout).toContain(
      "A new version of typescript is available: 5.6.3 -> 5.7.2",
    );
  });

  it("adds a configured entry the manager does not know as not installed", async () => {
    const fake = stdEnv();
    fake.writeConfig({
      surfaces: { npm: { tools: [{ name: "no-such-tool" }] } },
    });
    const result = await runCli(["status", "--surface", "npm"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "  npm,no-such-tool,false,null,null,null,null,null",
    );
  });
});

describe("status --json", () => {
  it("emits the normalized model with the same spelling", async () => {
    const fake = stdEnv();
    const result = await runCli(["status", "--json"], fake.env());
    expect(result.code).toBe(0);
    const model = JSON.parse(result.stdout) as {
      generatedAt: string;
      schemaVersion: number;
      tools: Array<Record<string, unknown>>;
      skew?: unknown;
      announce?: unknown;
    };
    expect(model.schemaVersion).toBe(1);
    expect(typeof model.generatedAt).toBe("string");
    expect(model.tools).toHaveLength(10);
    const typescript = model.tools.find((row) => row.tool === "typescript");
    expect(typescript).toEqual({
      surface: "npm",
      tool: "typescript",
      installed: true,
      version: "5.6.3",
      latest: "5.7.2",
      tier: "minor",
      apply: "npm install -g typescript@latest",
      pin: "npm install -g typescript@5.6.3",
    });
    const ghost = model.tools.find((row) => row.tool === "ghost");
    expect(ghost).toEqual({
      surface: "mise",
      tool: "ghost",
      installed: false,
    });
    const zizmor = model.tools.find((row) => row.tool === "zizmor");
    expect(zizmor?.latest).toBeUndefined();
    expect(zizmor?.tier).toBeUndefined();
    expect("skew" in model).toBe(false);
    expect("announce" in model).toBe(false);
  });

  it("carries skew and announcement blocks when present", async () => {
    const fake = stdEnv();
    const older = `${fake.root}/older`;
    const newer = `${fake.root}/newer`;
    fake.writeFakeIn(older, "fakecli", 'echo "fakecli 1.0.0"');
    fake.writeFakeIn(newer, "fakecli", 'echo "fakecli 2.0.0"');
    fake.writeConfig({
      surfaces: {
        npm: {
          tools: [
            {
              name: "esbuild",
              command: "fakecli",
              version_args: ["--version"],
            },
          ],
        },
      },
    });
    const result = await runCli(["status", "--surface", "npm", "--json"], {
      PATH: `${fake.binDir}:${older}:${newer}`,
      HOME: fake.root,
      XDG_CONFIG_HOME: fake.xdgDir,
    });
    expect(result.code).toBe(0);
    const model = JSON.parse(result.stdout) as {
      skew: Array<{
        surface: string;
        tool: string;
        command: string;
        resolvedPath: string;
        resolvedVersion: string;
        newerPath: string;
        newerVersion: string;
      }>;
    };
    expect(model.skew).toEqual([
      {
        surface: "npm",
        tool: "esbuild",
        command: "fakecli",
        resolvedPath: `${older}/fakecli`,
        resolvedVersion: "1.0.0",
        newerPath: `${newer}/fakecli`,
        newerVersion: "2.0.0",
      },
    ]);
  });

  it("accepts --json before the command", async () => {
    const fake = stdEnv();
    const result = await runCli(["--json"], fake.env());
    expect(result.code).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });
});

describe("usage errors", () => {
  it("rejects an unknown surface by naming the known ones", async () => {
    const fake = stdEnv();
    const result = await runCli(["status", "--surface", "nope"], fake.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("Unknown surface: nope");
    expect(result.stdout).toContain("Known surfaces: npm, mise, uv");
  });

  it("rejects an unknown flag by naming the valid flags", async () => {
    const fake = stdEnv();
    const result = await runCli(["status", "--bogus"], fake.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "error: Unknown flag `--bogus` for `status`",
    );
    expect(result.stdout).toContain(
      "Valid flags for `status`: --json, --surface <id[,id...]>, --config <path> (--help always allowed)",
    );
  });

  it("rejects a missing flag value", async () => {
    const fake = stdEnv();
    const result = await runCli(["status", "--surface"], fake.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("error: `--surface` requires a value");
  });

  it("rejects an invalid config file instead of ignoring it", async () => {
    const fake = stdEnv();
    const badPath = `${fake.root}/bad-config.json`;
    writeRawConfig(badPath, "{not json");
    const result = await runCli(["status", "--config", badPath], fake.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("Config file is not valid JSON:");
  });

  it("rejects an invalid announce_pattern at load time", async () => {
    const fake = stdEnv();
    fake.writeConfig({
      surfaces: {
        npm: {
          tools: [
            { name: "x", announce_pattern: "([bad", announce_args: ["--help"] },
          ],
        },
      },
    });
    const result = await runCli(["status"], fake.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("announce_pattern");
  });

  it("apply is not a command in this build", async () => {
    const fake = stdEnv();
    const result = await runCli(["apply"], fake.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("Unknown command: apply");
  });

  it("the built-in update refuses: upkeep-axi is not published to npm", async () => {
    const fake = stdEnv();
    const result = await runCli(["update"], fake.env());
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("upkeep-axi is not published to npm");
  });

  it("status --help prints the command help, not the top-level manual", async () => {
    const fake = stdEnv();
    const result = await runCli(["status", "--help"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("usage: upkeep-axi status [flags]");
    expect(result.stdout).toContain("--surface <id[,id...]>");
  });
});

describe("config resolution", () => {
  it("reads the default XDG path", async () => {
    const fake = stdEnv();
    fake.writeConfig({ surfaces: { npm: { enabled: false } } });
    const result = await runCli(["status"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("  npm,");
    expect(result.stdout).toContain("  mise,");
  });

  it("reads --config over the default path", async () => {
    const fake = stdEnv();
    const alt = `${fake.root}/alt-config.json`;
    writeRawConfig(
      alt,
      JSON.stringify({
        surfaces: { mise: { enabled: false }, uv: { enabled: false } },
      }),
    );
    const viaFlag = await runCli(["status", "--config", alt], fake.env());
    expect(viaFlag.code).toBe(0);
    expect(viaFlag.stdout).not.toContain("  mise,");
    expect(viaFlag.stdout).toContain("  npm,");
  });

  it("rejects an unknown surface id in config", async () => {
    const fake = stdEnv();
    fake.writeConfig({ surfaces: { npn: { enabled: false } } });
    const result = await runCli(["status"], fake.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "Config `surfaces.npn` is not a known surface (known: npm, mise, uv)",
    );
  });

  it("rejects a config whose tools entries lack a name", async () => {
    const fake = stdEnv();
    fake.writeConfig({ surfaces: { npm: { tools: [{ command: "x" }] } } });
    const result = await runCli(["status"], fake.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("Config `surfaces.npm.tools[0].name`");
  });
});

describe("version fast path", () => {
  it.each(["-v", "-V", "--version"])(
    "answers %s with the bare version",
    async (flag) => {
      const result = await runCli([flag], stdEnv().env());
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("0.1.0\n");
    },
  );

  it("is served before the command graph loads (bin fast path)", async () => {
    // The bin must answer a bare version flag without importing the CLI
    // module; spawn it directly with a PATH that would make any probe fail.
    const { spawn } = await import("node:child_process");
    const fake = createEnv();
    const result = await new Promise<{ code: number | null; stdout: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [CLI_PATH, "--version"], {
          env: fake.env(),
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf-8");
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout }));
      },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("0.1.0\n");
  });
});
