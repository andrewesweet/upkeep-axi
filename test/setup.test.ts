import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

const AMBIENT_ENTRY = "dist/bin/upkeep-axi-ambient.js";

describe("setup hooks", () => {
  it("installs marker-matched hooks for Claude Code, Codex, and OpenCode", async () => {
    const fake = stdEnv();
    const result = await runCli(["setup", "hooks"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    // The report names all three integrations and the Codex feature flag.
    expect(result.stdout).toContain("hooks[3]{agent,installed,path}:");
    expect(result.stdout).toContain("  claude,true,~/.claude/settings.json");
    expect(result.stdout).toContain("  codex,true,~/.codex/hooks.json");
    expect(result.stdout).toContain(
      "  opencode,true,~/.config/opencode/plugins/axi-upkeep-axi.js",
    );
    expect(result.stdout).toContain("codex_hooks_feature: true");
    expect(result.stdout).toContain(
      "Restart your agent session to receive upkeep-axi ambient context",
    );

    // Claude Code: a SessionStart hook whose command is the ambient
    // entrypoint of the build that ran setup.
    const claude = JSON.parse(
      readFileSync(join(fake.root, ".claude/settings.json"), "utf-8"),
    ) as {
      hooks: {
        SessionStart: Array<{
          hooks: Array<{ type: string; command: string; timeout: number }>;
        }>;
      };
    };
    const entry = claude.hooks.SessionStart[0].hooks[0];
    expect(entry.type).toBe("command");
    expect(entry.command.endsWith(AMBIENT_ENTRY)).toBe(true);
    expect(existsSync(entry.command)).toBe(true);
    // The dashboard reads a saved inventory, so the SDK's default budget holds.
    expect(entry.timeout).toBe(10);

    // Codex: the hook plus the user-level feature flag it needs.
    const codex = JSON.parse(
      readFileSync(join(fake.root, ".codex/hooks.json"), "utf-8"),
    ) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(
      codex.hooks.SessionStart[0].hooks[0].command.endsWith(AMBIENT_ENTRY),
    ).toBe(true);
    const codexConfig = readFileSync(
      join(fake.root, ".codex/config.toml"),
      "utf-8",
    );
    expect(codexConfig).toContain("hooks = true");

    // OpenCode: a managed plugin carrying the marker and the same command.
    const plugin = readFileSync(
      join(fake.root, ".config/opencode/plugins/axi-upkeep-axi.js"),
      "utf-8",
    );
    expect(plugin).toContain("managed opencode plugin: upkeep-axi");
    expect(plugin).toContain(AMBIENT_ENTRY);
  });

  it("is a silent no-op when everything is already current", async () => {
    const fake = stdEnv();
    await runCli(["setup", "hooks"], fake.env());
    const before = readFileSync(
      join(fake.root, ".claude/settings.json"),
      "utf-8",
    );
    const result = await runCli(["setup", "hooks"], fake.env());
    expect(result.code).toBe(0);
    const after = readFileSync(
      join(fake.root, ".claude/settings.json"),
      "utf-8",
    );
    expect(after).toBe(before);
    expect(result.stdout).toContain("  claude,true,");
  });

  it("repairs the hook command after the tool moved", async () => {
    const fake = stdEnv();
    await runCli(["setup", "hooks"], fake.env());
    const settingsPath = join(fake.root, ".claude/settings.json");
    const stale = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: {
        SessionStart: Array<{ hooks: Array<{ command: string }> }>;
      };
    };
    stale.hooks.SessionStart[0].hooks[0].command =
      "/old/place/" + AMBIENT_ENTRY;
    writeFileSync(settingsPath, JSON.stringify(stale, null, 2));
    const result = await runCli(["setup", "hooks"], fake.env());
    expect(result.code).toBe(0);
    const repaired = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: {
        SessionStart: Array<{ hooks: Array<{ command: string }> }>;
      };
    };
    expect(
      repaired.hooks.SessionStart[0].hooks[0].command.endsWith(AMBIENT_ENTRY),
    ).toBe(true);
    expect(
      repaired.hooks.SessionStart[0].hooks[0].command.startsWith("/old/place/"),
    ).toBe(false);
  });

  it("reports status without writing, before and after install", async () => {
    const fake = stdEnv();
    const before = await runCli(["setup", "hooks", "--status"], fake.env());
    expect(before.code).toBe(0);
    expect(before.stdout).toContain("  claude,false,~/.claude/settings.json");
    expect(before.stdout).toContain("codex_hooks_feature: false");
    expect(before.stdout).toContain(
      "Run `upkeep-axi setup hooks` to install or repair the hooks",
    );
    // The fixture settings (claude plugins) carry no hook: --status wrote none.
    const untouched = JSON.parse(
      readFileSync(join(fake.root, ".claude/settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(untouched.hooks).toBeUndefined();

    await runCli(["setup", "hooks"], fake.env());
    const after = await runCli(["setup", "hooks", "--status"], fake.env());
    expect(after.code).toBe(0);
    expect(after.stdout).toContain("  claude,true,");
    expect(after.stdout).toContain("  opencode,true,");
  });

  it("emits the same model as --json", async () => {
    const fake = stdEnv();
    const result = await runCli(
      ["setup", "hooks", "--status", "--json"],
      fake.env(),
    );
    expect(result.code).toBe(0);
    const model = JSON.parse(result.stdout) as {
      generatedAt: string;
      schemaVersion: number;
      hooks: Array<{ agent: string; installed: boolean; path: string }>;
      codexFeature: { enabled: boolean; path: string };
    };
    expect(model.schemaVersion).toBe(3);
    expect(model.hooks.map((row) => row.agent)).toEqual([
      "claude",
      "codex",
      "opencode",
    ]);
    expect(model.hooks.every((row) => row.installed === false)).toBe(true);
    expect(model.codexFeature.enabled).toBe(false);
    expect(model.codexFeature.path).toBe("~/.codex/config.toml");
  });

  it("rejects unknown setup actions and stray arguments with a usage error", async () => {
    const fake = stdEnv();
    for (const argv of [
      ["setup"],
      ["setup", "plugins"],
      ["setup", "hooks", "extra"],
    ]) {
      const result = await runCli(argv, fake.env());
      expect(result.code).toBe(2);
      expect(result.stderr).toBe("");
      expect(result.stdout).toMatch(/^error: /);
      expect(result.stdout).toContain("Run `upkeep-axi setup hooks`");
    }
    // Nothing was written by any refused invocation: the fixture settings
    // still carry no hook.
    const settings = JSON.parse(
      readFileSync(join(fake.root, ".claude/settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    expect(settings.hooks).toBeUndefined();
    expect(existsSync(join(fake.root, ".codex"))).toBe(false);
  });

  it("names the ambient entrypoint in --help and top-level help", async () => {
    const fake = stdEnv();
    const setupHelp = await runCli(["setup", "--help"], fake.env());
    expect(setupHelp.code).toBe(0);
    expect(setupHelp.stdout).toContain("usage: upkeep-axi setup hooks");
    const ambientHelp = await runCli(["ambient", "--help"], fake.env());
    expect(ambientHelp.code).toBe(0);
    expect(ambientHelp.stdout).toContain("usage: upkeep-axi ambient");
    const topHelp = await runCli(["--help"], fake.env());
    expect(topHelp.stdout).toContain("setup=install or repair");
    expect(topHelp.stdout).toContain(
      "ambient=the bounded session-start dashboard",
    );
  });
});
