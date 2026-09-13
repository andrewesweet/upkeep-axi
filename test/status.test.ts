import { rmSync, writeFileSync } from "node:fs";
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
    // One row per tool, fixed columns:
    // 5 npm + 3 mise + 2 uv + 3 cargo + 2 bun + 4 gh + 2 skills + 1 fnm + 3 apt
    // + 6 claude + 1 codex + 1 opencode + 2 pi + 3 herdr + 1 no-mistakes
    // + 1 firstmate (no git on the fake PATH).
    expect(out).toContain(
      "tools[40]{surface,tool,installed,version,latest,tier,in_use,apply,pin}:",
    );
    // npm rows: tier none, minor, unparseable-as-major, and unknown latest.
    expect(out).toContain(
      "  npm,left-pad,true,1.3.0,1.3.0,none,false,npm install -g left-pad@latest,npm install -g left-pad@1.3.0",
    );
    expect(out).toContain(
      "  npm,typescript,true,5.6.3,5.7.2,minor,false,npm install -g typescript@latest,npm install -g typescript@5.6.3",
    );
    // An unparseable gap is major, never casual.
    expect(out).toContain(
      "  npm,unparsable,true,dev,2026.09.0,major,false,npm install -g unparsable@latest,npm install -g unparsable@dev",
    );
    // A failed latest read stays absent: no latest, no tier.
    expect(out).toContain(
      "  npm,gone,true,2.0.0,null,null,false,npm install -g gone@latest,npm install -g gone@2.0.0",
    );
    // mise reports itself plus managed tools; a configured-not-installed
    // entry reports installed=false.
    expect(out).toContain(
      "  mise,mise,true,2026.8.8,null,null,false,mise self-update,mise self-update 2026.8.8",
    );
    expect(out).toContain(
      "  mise,node,true,20.11.0,22.0.0,major,false,mise upgrade node,mise use -g node@20.11.0",
    );
    expect(out).toContain("  mise,ghost,false,null,null,null,null,null");
    // A configured-not-installed mise entry reports only its absence.
    expect(out).toContain("  mise,ghost,false,null,null,null,null,null");
    // uv tools with and without a known update.
    expect(out).toContain(
      "  uv,ruff,true,0.3.4,0.9.0,minor,false,uv tool upgrade ruff,uv tool install ruff==0.3.4",
    );
    expect(out).toContain(
      "  uv,zizmor,true,1.24.1,null,null,false,uv tool upgrade zizmor,uv tool install zizmor==1.24.1",
    );
    // cargo crates: searched latest, current, and a crate the search does
    // not name (latest and tier stay absent); pin drops the `v` prefix.
    expect(out).toContain(
      "  cargo,bacon,true,3.10.0,3.12.4,minor,false,cargo install bacon,cargo install bacon --version 3.10.0",
    );
    expect(out).toContain(
      "  cargo,fd-find,true,10.2.0,10.2.0,none,false,cargo install fd-find,cargo install fd-find --version 10.2.0",
    );
    expect(out).toContain(
      "  cargo,unsearchable,true,0.1.0,null,null,false,cargo install unsearchable,cargo install unsearchable --version 0.1.0",
    );
    // bun globals: header line skipped, registry check per package.
    expect(out).toContain(
      "  bun,critique,true,0.1.140,0.2.0,minor,false,bun install -g critique@latest,bun install -g critique@0.1.140",
    );
    expect(out).toContain(
      "  bun,stale,true,2.0.0,null,null,false,bun install -g stale@latest,bun install -g stale@2.0.0",
    );
    // gh itself has no self-update check; extensions read the dry-run: the
    // up-to-date one keeps latest absent, the pinned one carries no apply.
    expect(out).toContain("  gh,gh,true,2.97.0,null,null,null,null");
    expect(out).toContain(
      "  gh,stack,true,v0.1.1,null,null,false,gh extension upgrade stack,null",
    );
    expect(out).toContain(
      "  gh,dash,true,v1.1.0,v1.2.0,minor,false,gh extension upgrade dash,null",
    );
    expect(out).toContain("  gh,pinned,true,v0.3.0,null,null,null,null");
    // skills report installed only: the CLI exposes no update check.
    expect(out).toContain(
      "  skills,caveman,true,null,null,null,false,skills update -g caveman,null",
    );
    expect(out).toContain(
      "  skills,handoff,true,null,null,null,false,skills update -g handoff,null",
    );
    // fnm collapses to the default-alias version; installing alone does not
    // update, so the apply names both acts.
    expect(out).toContain(
      "  fnm,node,true,v24.18.0,v24.21.0,minor,false,fnm install v24.21.0 && fnm default v24.21.0,fnm default v24.18.0",
    );
    // apt rows are report-only with the exact sudo commands; the
    // revision-only bump tiers none while the major is a major.
    expect(out).toContain(
      "  apt,openssl,true,3.0.2-0ubuntu1.14,3.0.2-0ubuntu1.15,none,false,sudo apt-get update && sudo apt-get upgrade,sudo apt-get install openssl=3.0.2-0ubuntu1.14",
    );
    expect(out).toContain(
      "  apt,ripgrep,true,14.1.1,15.0.0,major,false,sudo apt-get update && sudo apt-get upgrade,sudo apt-get install ripgrep=14.1.1",
    );
    expect(out).toContain(
      "  apt,reboot-required,false,null,null,null,null,null,null",
    );
    // Claude Code itself pins via its native installer; plugin versions come
    // from the plugin manifest or the installer's record; enabled but not
    // installed plugins report only their absence; marketplaces report their
    // own update command.
    expect(out).toContain(
      "  claude,claude,true,2.1.270,null,null,false,claude update,claude install 2.1.270",
    );
    expect(out).toContain(
      "  claude,gopls-lsp@claude-plugins-official,true,1.0.0,null,null,false,claude plugin update gopls-lsp@claude-plugins-official,null",
    );
    expect(out).toContain(
      "  claude,context7@claude-plugins-official,true,3deb821cb71c,null,null,false,claude plugin update context7@claude-plugins-official,null",
    );
    expect(out).toContain(
      "  claude,ghost-plugin@ghost-market,false,null,null,null,null,null,null",
    );
    expect(out).toContain(
      "  claude,claude-plugins-official,true,null,null,null,false,claude plugin marketplace update claude-plugins-official,null",
    );
    expect(out).toContain(
      "  claude,caveman,true,null,null,null,false,claude plugin marketplace update caveman,null",
    );
    // Codex reads its latest from the npm registry Codex's docs name and
    // updates itself; its installer exposes no pin.
    expect(out).toContain(
      "  codex,codex,true,0.154.0,0.155.0,minor,false,codex update,null",
    );
    expect(out).toContain(
      "  opencode,opencode,true,1.18.13,null,null,false,opencode upgrade,opencode upgrade 1.18.13",
    );
    // pi list reports install sources, not versions, so package rows carry no
    // version; pi itself pins nothing (no vendor pin command). TOON quotes
    // values containing its delimiter characters.
    expect(out).toContain(
      "  pi,pi,true,0.85.1,null,null,false,pi update self,null",
    );
    expect(out).toContain(
      '  pi,"github:owner/some-pi-ext",true,null,null,null,false,"pi update github:owner/some-pi-ext",null',
    );
    // Herdr plugins are inventory only: herdr exposes no plugin updater.
    expect(out).toContain(
      "  herdr,herdr,true,0.9.0,null,null,false,herdr update,null",
    );
    expect(out).toContain(
      "  herdr,annotate,true,0.4.0,null,null,null,null,null",
    );
    expect(out).toContain("  herdr,collie,true,1.8.0,null,null,null,null,null");
    expect(out).toContain(
      "  no-mistakes,no-mistakes,true,1.72.0,null,null,false,no-mistakes update,null",
    );
    // Registry order: every surface keeps its declaration position.
    expect(out.indexOf("  npm,")).toBeLessThan(out.indexOf("  mise,"));
    expect(out.indexOf("  mise,")).toBeLessThan(out.indexOf("  uv,"));
    expect(out.indexOf("  uv,")).toBeLessThan(out.indexOf("  cargo,"));
    expect(out.indexOf("  cargo,")).toBeLessThan(out.indexOf("  bun,"));
    expect(out.indexOf("  bun,")).toBeLessThan(out.indexOf("  gh,"));
    expect(out.indexOf("  gh,")).toBeLessThan(out.indexOf("  skills,"));
    expect(out.indexOf("  skills,")).toBeLessThan(out.indexOf("  fnm,"));
    expect(out.indexOf("  fnm,")).toBeLessThan(out.indexOf("  apt,"));
    expect(out.indexOf("  apt,")).toBeLessThan(out.indexOf("  claude,"));
    expect(out.indexOf("  claude,")).toBeLessThan(out.indexOf("  codex,"));
    expect(out.indexOf("  codex,")).toBeLessThan(out.indexOf("  opencode,"));
    expect(out.indexOf("  opencode,")).toBeLessThan(out.indexOf("  pi,"));
    expect(out.indexOf("  pi,")).toBeLessThan(out.indexOf("  herdr,"));
    expect(out.indexOf("  herdr,")).toBeLessThan(out.indexOf("  no-mistakes,"));
    // Sparse blocks stay absent when there is nothing to report.
    expect(out).not.toContain("skew[");
    expect(out).not.toContain("announce[");
    expect(out).not.toContain("errors[");
    // Pre-computed counts: only known gaps count, zero facts stay absent.
    expect(out).toContain(
      "summary:\n  tools: 40\n  gaps: 10\n  major: 3\n  minor: 7",
    );
    // Contextual help, derived from the invocation: gaps present suggest
    // apply, and the scoping hint stays.
    expect(out).toContain("help[3]:");
    expect(out).toContain(
      "Run `upkeep-axi apply --all --tier <patch|minor|major>` to plan every gap at or below the tier",
    );
    expect(out).toContain(
      "Run `upkeep-axi status --surface <id>` to scope to one surface",
    );
    expect(out).toContain(
      "Run `upkeep-axi status --json` for the normalized model",
    );
  });

  it("bare invocation behaves like status", async () => {
    const fake = stdEnv();
    const result = await runCli([], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "tools[40]{surface,tool,installed,version,latest,tier,in_use,apply,pin}:",
    );
  });

  it("omits a disabled surface and honors --surface scoping", async () => {
    const fake = stdEnv();
    fake.writeConfig({ surfaces: { uv: { enabled: false } } });
    const all = await runCli(["status"], fake.env());
    expect(all.code).toBe(0);
    expect(all.stdout).not.toContain("  uv,");
    expect(all.stdout).toContain(
      "tools[38]{surface,tool,installed,version,latest,tier,in_use,apply,pin}:",
    );
    const scoped = await runCli(
      ["status", "--surface", "npm,mise"],
      fake.env(),
    );
    expect(scoped.code).toBe(0);
    expect(scoped.stdout).toContain(
      "tools[8]{surface,tool,installed,version,latest,tier,in_use,apply,pin}:",
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
  echo '{"jq":[{"version":"1.8.1","installed":true,"active":false},{"version":"1.8.2","installed":true,"active":true},{"version":"1.9.0","installed":true,"active":false}],"just":[{"version":"1.57.0","installed":true,"active":false},{"version":"1.58.0","installed":true,"active":false}],"node":[{"version":"20.11.0","installed":true,"active":false},{"version":"22.0.0","installed":false,"active":true}]}'
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
      "tools[4]{surface,tool,installed,version,latest,tier,in_use,apply,pin}:",
    );
    expect(result.stdout).toContain(
      "  mise,jq,true,1.8.2,1.8.3,patch,false,mise upgrade jq,mise use -g jq@1.8.2",
    );
    expect(result.stdout).toContain(
      "  mise,node,true,20.11.0,null,null,false,mise upgrade node,mise use -g node@20.11.0",
    );
    expect(result.stdout).toContain(
      "  mise,just,true,1.58.0,null,null,false,mise upgrade just,mise use -g just@1.58.0",
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
      "tools[1]{surface,tool,installed,version,latest,tier,in_use,apply,pin}:",
    );
    expect(missing.stdout).toContain(
      "  mise,mise,false,null,null,null,null,null,null",
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
      "  mise,mise,true,2026.8.8,null,null,null,null,null",
    );
  });
});

describe("cargo surface", () => {
  it("reports a missing cargo as one not-installed row", async () => {
    const bare = createEnv();
    bare.writeFake("npm", "exit 0");
    const result = await runCli(["status", "--surface", "cargo"], bare.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "tools[1]{surface,tool,installed,version,latest,tier,in_use,apply,pin}:",
    );
    expect(result.stdout).toContain(
      "  cargo,cargo,false,null,null,null,null,null,null",
    );
  });

  it("reports a failed crate inventory verbatim in the errors block", async () => {
    const fake = createEnv();
    fake.writeFake(
      "cargo",
      `if [ "$1" = "install" ]; then
  echo "cargo fake: index exploded" >&2
  exit 3
fi
if [ "$1" = "--version" ]; then
  echo "cargo 1.89.0"
  exit 0
fi
exit 1`,
    );
    const result = await runCli(["status", "--surface", "cargo"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("errors[1]{surface,tool,detail}:");
    expect(result.stdout).toContain(
      "cargo,cargo,cargo install --list failed (exit 3)",
    );
    expect(result.stdout).toContain(
      "  cargo,cargo,true,1.89.0,null,null,null,null,null",
    );
  });
});

describe("bun surface", () => {
  it("reports a missing bun as one not-installed row", async () => {
    const bare = createEnv();
    bare.writeFake("npm", "exit 0");
    const result = await runCli(["status", "--surface", "bun"], bare.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("  bun,bun,false,null,null,null,null,null");
  });

  it("reports a failed global listing verbatim in the errors block", async () => {
    const fake = createEnv();
    fake.writeFake(
      "bun",
      `if [ "$1" = "pm" ] && [ "$2" = "ls" ]; then
  echo "bun fake: store locked" >&2
  exit 1
fi
if [ "$1" = "--version" ]; then
  echo "1.3.14"
  exit 0
fi
exit 1`,
    );
    const result = await runCli(["status", "--surface", "bun"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("errors[1]{surface,tool,detail}:");
    expect(result.stdout).toContain("bun,bun,bun pm ls -g failed (exit 1)");
    expect(result.stdout).toContain(
      "  bun,bun,true,1.3.14,null,null,null,null,null",
    );
  });
});

describe("gh surface", () => {
  it("reports a missing gh as one not-installed row", async () => {
    const bare = createEnv();
    bare.writeFake("npm", "exit 0");
    const result = await runCli(["status", "--surface", "gh"], bare.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("  gh,gh,false,null,null,null,null,null");
  });

  it("keeps latest absent when the dry-run check is unavailable", async () => {
    const fake = createEnv();
    fake.writeFake(
      "gh",
      `if [ "$1" = "--version" ]; then
  echo "gh version 2.20.0"
  exit 0
fi
if [ "$1" = "extension" ] && [ "$2" = "list" ]; then
  echo 'gh dash\tdnorth98/gh-dash\tv1.1.0'
  exit 0
fi
exit 1`,
    );
    const result = await runCli(["status", "--surface", "gh"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "  gh,dash,true,v1.1.0,null,null,false,gh extension upgrade dash,null",
    );
  });

  it("reports a failed extension listing verbatim in the errors block", async () => {
    const fake = createEnv();
    fake.writeFake(
      "gh",
      `if [ "$1" = "--version" ]; then
  echo "gh version 2.97.0"
  exit 0
fi
if [ "$1" = "extension" ] && [ "$2" = "list" ]; then
  echo "gh fake: host refused" >&2
  exit 4
fi
exit 1`,
    );
    const result = await runCli(["status", "--surface", "gh"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("errors[1]{surface,tool,detail}:");
    expect(result.stdout).toContain("gh,gh,gh extension list failed (exit 4)");
    expect(result.stdout).toContain("  gh,gh,true,2.97.0,null,null,null,null");
  });
});

describe("skills surface", () => {
  it("reports not installed when neither skills nor npx is on PATH", async () => {
    const bare = createEnv();
    bare.writeFake("npm", "exit 0");
    const result = await runCli(["status", "--surface", "skills"], bare.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "  skills,skills,false,null,null,null,null,null,null",
    );
  });

  it("falls back to npx -y skills when no skills binary is on PATH", async () => {
    const fake = createEnv();
    fake.writeFake(
      "npx",
      `if [ "$1" = "-y" ] && [ "$2" = "skills" ] && [ "$3" = "list" ] && [ "$4" = "-g" ]; then
  echo 'Global Skills'
  echo ''
  echo 'find-skills                        ~/.agents/skills/find-skills'
  echo '  Agents: Claude Code  Source: vercel-labs/skills'
  exit 0
fi
exit 1`,
    );
    const result = await runCli(["status", "--surface", "skills"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "tools[1]{surface,tool,installed,version,latest,tier,in_use,apply,pin}:",
    );
    expect(result.stdout).toContain(
      "  skills,find-skills,true,null,null,null,false,npx -y skills update -g find-skills,null",
    );
  });

  it("reports a failed listing verbatim in the errors block", async () => {
    const fake = createEnv();
    fake.writeFake(
      "skills",
      `if [ "$1" = "list" ]; then
  echo "skills fake: offline" >&2
  exit 1
fi
exit 1`,
    );
    const result = await runCli(["status", "--surface", "skills"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("errors[1]{surface,tool,detail}:");
    expect(result.stdout).toContain(
      "skills,skills,skills list -g failed (exit 1)",
    );
    expect(result.stdout).toContain(
      "  skills,skills,true,null,null,null,null,null,null",
    );
  });
});

describe("fnm surface", () => {
  it("reports a missing fnm as one not-installed row", async () => {
    const bare = createEnv();
    bare.writeFake("npm", "exit 0");
    const result = await runCli(["status", "--surface", "fnm"], bare.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("  fnm,fnm,false,null,null,null,null,null");
  });

  it("reports node as not installed when no version is installed", async () => {
    const fake = createEnv();
    fake.writeFake(
      "fnm",
      `if [ "$1" = "list" ]; then
  echo '* system'
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "fnm 1.38.2"
  exit 0
fi
exit 1`,
    );
    const result = await runCli(["status", "--surface", "fnm"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "tools[1]{surface,tool,installed,version,latest,tier,in_use,apply,pin}:",
    );
    expect(result.stdout).toContain(
      "  fnm,node,false,null,null,null,null,null,null",
    );
  });

  it("falls back to the last installed version when no default alias is set", async () => {
    const fake = createEnv();
    fake.writeFake(
      "fnm",
      `if [ "$1" = "list" ]; then
  echo '* v22.20.0'
  echo '* v24.18.0'
  exit 0
fi
if [ "$1" = "ls-remote" ]; then
  echo 'v24.21.0 (Krypton)'
  exit 0
fi
exit 1`,
    );
    const result = await runCli(["status", "--surface", "fnm"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "  fnm,node,true,v24.18.0,v24.21.0,minor,false,fnm install v24.21.0 && fnm default v24.21.0,fnm default v24.18.0",
    );
  });

  it("publishes no apply command when the default is newer than the LTS", async () => {
    const fake = createEnv();
    fake.writeFake(
      "fnm",
      `if [ "$1" = "list" ]; then
  echo '* v25.2.0 default'
  exit 0
fi
if [ "$1" = "ls-remote" ]; then
  echo 'v24.21.0 (Krypton)'
  exit 0
fi
exit 1`,
    );
    const result = await runCli(["status", "--surface", "fnm"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "  fnm,node,true,v25.2.0,v24.21.0,none,null,null,fnm default v25.2.0",
    );
  });

  it("keeps the apply command absent when no latest LTS is learned", async () => {
    const fake = createEnv();
    fake.writeFake(
      "fnm",
      `if [ "$1" = "list" ]; then
  echo '* v24.18.0 default'
  exit 0
fi
if [ "$1" = "ls-remote" ]; then
  echo "fnm fake: mirror down" >&2
  exit 7
fi
exit 1`,
    );
    const result = await runCli(["status", "--surface", "fnm"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "  fnm,node,true,v24.18.0,null,null,null,null,fnm default v24.18.0",
    );
  });
});

describe("apt surface", () => {
  it("reports a missing apt as one not-installed row", async () => {
    const bare = createEnv();
    bare.writeFake("npm", "exit 0");
    const result = await runCli(["status", "--surface", "apt"], bare.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("  apt,apt,false,null,null,null,null,null");
  });

  it("reports a failed package listing verbatim in the errors block", async () => {
    const fake = createEnv();
    fake.writeFake(
      "apt",
      `if [ "$1" = "list" ]; then
  echo "apt fake: lists locked" >&2
  exit 100
fi
if [ "$1" = "--version" ]; then
  echo "apt 2.8.3 (amd64)"
  exit 0
fi
exit 1`,
    );
    const result = await runCli(["status", "--surface", "apt"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("errors[1]{surface,tool,detail}:");
    expect(result.stdout).toContain(
      "apt,apt,apt list --upgradable failed (exit 100)",
    );
    expect(result.stdout).toContain("  apt,apt,true,2.8.3,null,null,null,null");
  });

  it("reports the reboot-required flag when the configured path exists", async () => {
    const fake = createEnv();
    const flag = `${fake.root}/reboot-required`;
    writeFileSync(flag, "*** System restart required ***\n");
    fake.writeFake(
      "apt",
      `if [ "$1" = "list" ] && [ "$2" = "--upgradable" ]; then
  echo 'Listing...'
  exit 0
fi
exit 1`,
    );
    fake.writeConfig({
      surfaces: { apt: { rebootRequiredPath: flag } },
    });
    const result = await runCli(["status", "--surface", "apt"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "  apt,reboot-required,true,null,null,null,null,null,null",
    );
  });

  it("tiers a Debian epoch bump as major", async () => {
    const fake = createEnv();
    fake.writeFake(
      "apt",
      `if [ "$1" = "list" ] && [ "$2" = "--upgradable" ]; then
  echo 'Listing...'
  echo 'vim/nowhere 2:1.0-1 amd64 [upgradable from: 1:9.1-1]'
  exit 0
fi
exit 1`,
    );
    const result = await runCli(["status", "--surface", "apt"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      '  apt,vim,true,"1:9.1-1","2:1.0-1",major,false,sudo apt-get update && sudo apt-get upgrade,"sudo apt-get install vim=1:9.1-1"',
    );
  });

  it("carries no installed version when apt names no upgradable-from", async () => {
    const fake = createEnv();
    fake.writeFake(
      "apt",
      `if [ "$1" = "list" ] && [ "$2" = "--upgradable" ]; then
  echo 'Listing...'
  echo 'ripgrep/nowhere 15.0.0 amd64'
  exit 0
fi
exit 1`,
    );
    const result = await runCli(["status", "--surface", "apt"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "  apt,ripgrep,true,null,15.0.0,null,false,sudo apt-get update && sudo apt-get upgrade,null",
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
      "  npm,no-such-tool,false,null,null,null,null,null,null",
    );
  });
});

describe("agent tooling surfaces", () => {
  it("reports a claude state file that does not parse verbatim and keeps surviving facts", async () => {
    const fake = stdEnv();
    fake.writeFakeFile(".claude/settings.json", "{not json");
    const result = await runCli(["status", "--surface", "claude"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("errors[1]{surface,tool,detail}:");
    expect(result.stdout).toContain(
      "claude,claude,claude settings.json is not valid JSON",
    );
    expect(result.stdout).toContain(
      "  claude,claude,true,2.1.270,null,null,false,claude update,claude install 2.1.270",
    );
    // The enabled list is unreadable, so no plugin row is claimed; the
    // marketplaces come from their own file and survive.
    expect(result.stdout).toContain(
      "tools[3]{surface,tool,installed,version,latest,tier,in_use,apply,pin}:",
    );
    expect(result.stdout).toContain(
      "  claude,claude-plugins-official,true,null,null,null,false,claude plugin marketplace update claude-plugins-official,null",
    );
    expect(result.stdout).not.toContain("gopls-lsp");
  });

  it("claims no plugin rows when the claude install record does not parse", async () => {
    const fake = stdEnv();
    fake.writeFakeFile(".claude/plugins/installed_plugins.json", "{not json");
    const result = await runCli(["status", "--surface", "claude"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "claude,claude,claude installed_plugins.json is not valid JSON",
    );
    expect(result.stdout).toContain(
      "tools[3]{surface,tool,installed,version,latest,tier,in_use,apply,pin}:",
    );
    expect(result.stdout).not.toContain("gopls-lsp");
    expect(result.stdout).not.toContain("ghost-plugin");
  });

  it("keeps the claude row when a state file holds the JSON literal null", async () => {
    const fake = stdEnv();
    fake.writeFakeFile(".claude/settings.json", "null");
    fake.writeFakeFile(".claude/plugins/installed_plugins.json", "null");
    fake.writeFakeFile(".claude/plugins/known_marketplaces.json", "null");
    const result = await runCli(["status", "--surface", "claude"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "tools[1]{surface,tool,installed,version,latest,tier,in_use,apply,pin}:",
    );
    expect(result.stdout).toContain(
      "  claude,claude,true,2.1.270,null,null,false,claude update,claude install 2.1.270",
    );
  });

  it("keeps codex latest and tier absent when the npm registry read fails", async () => {
    const fake = stdEnv();
    fake.writeFake(
      "npm",
      `if [ "$1" = "view" ]; then
  echo "npm fake: registry unreachable" >&2
  exit 1
fi
exit 1`,
    );
    const result = await runCli(["status", "--surface", "codex"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "  codex,codex,true,0.154.0,null,null,false,codex update,null",
    );
  });

  it("reports a failed pi list verbatim and an empty pi list as absence", async () => {
    const failing = createEnv();
    failing.writeFake(
      "pi",
      `if [ "$1" = "--version" ]; then
  echo "0.85.1"
  exit 0
fi
if [ "$1" = "list" ]; then
  echo "pi fake: settings unreadable" >&2
  exit 3
fi
exit 1`,
    );
    const failed = await runCli(["status", "--surface", "pi"], failing.env());
    expect(failed.code).toBe(0);
    expect(failed.stdout).toContain("errors[1]{surface,tool,detail}:");
    expect(failed.stdout).toContain("pi,pi,pi list failed (exit 3)");
    expect(failed.stdout).toContain(
      "  pi,pi,true,0.85.1,null,null,false,pi update self,null",
    );

    const empty = createEnv();
    empty.writeFake(
      "pi",
      `if [ "$1" = "--version" ]; then
  echo "0.85.1"
  exit 0
fi
if [ "$1" = "list" ]; then
  echo "No packages installed."
  exit 0
fi
exit 1`,
    );
    const emptyResult = await runCli(
      ["status", "--surface", "pi"],
      empty.env(),
    );
    expect(emptyResult.code).toBe(0);
    expect(emptyResult.stdout).toContain(
      "tools[1]{surface,tool,installed,version,latest,tier,in_use,apply,pin}:",
    );
    expect(emptyResult.stdout).toContain(
      "  pi,pi,true,0.85.1,null,null,false,pi update self,null",
    );
  });

  it("reports herdr without a plugins.json as one row and a broken one verbatim", async () => {
    const bare = createEnv();
    bare.writeFake(
      "herdr",
      `if [ "$1" = "--version" ]; then
  echo "herdr 0.9.0"
  exit 0
fi
exit 1`,
    );
    const missing = await runCli(["status", "--surface", "herdr"], bare.env());
    expect(missing.code).toBe(0);
    expect(missing.stdout).toContain(
      "tools[1]{surface,tool,installed,version,latest,tier,in_use,apply,pin}:",
    );
    expect(missing.stdout).toContain(
      "  herdr,herdr,true,0.9.0,null,null,false,herdr update,null",
    );

    const broken = createEnv();
    broken.writeFake(
      "herdr",
      `if [ "$1" = "--version" ]; then
  echo "herdr 0.9.0"
  exit 0
fi
exit 1`,
    );
    broken.writeFakeFile("xdg/herdr/plugins.json", "[{not json");
    const brokenResult = await runCli(
      ["status", "--surface", "herdr"],
      broken.env(),
    );
    expect(brokenResult.code).toBe(0);
    expect(brokenResult.stdout).toContain("errors[1]{surface,tool,detail}:");
    expect(brokenResult.stdout).toContain(
      "herdr,herdr,herdr plugins.json is not valid JSON",
    );
    expect(brokenResult.stdout).toContain(
      "  herdr,herdr,true,0.9.0,null,null,false,herdr update,null",
    );
  });

  it("reports each missing agent tool as its own not-installed row", async () => {
    const bare = createEnv();
    const result = await runCli(
      ["status", "--surface", "claude,codex,opencode,pi,herdr,no-mistakes"],
      bare.env(),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "tools[6]{surface,tool,installed,version,latest,tier,in_use,apply,pin}:",
    );
    for (const tool of [
      "claude",
      "codex",
      "opencode",
      "pi",
      "herdr",
      "no-mistakes",
    ]) {
      expect(result.stdout).toContain(
        `  ${tool},${tool},false,null,null,null,null,null`,
      );
    }
  });

  it("carries no-mistakes' own announcement via the watched-tools args", async () => {
    const fake = stdEnv();
    fake.writeConfig({
      surfaces: {
        "no-mistakes": {
          tools: [
            {
              name: "no-mistakes",
              command: "no-mistakes",
              version_args: ["--version"],
              announce_args: ["--help"],
              announce_pattern:
                "A new version of no-mistakes is available: [^ ]+ -> [^ ]+",
            },
          ],
        },
      },
    });
    const result = await runCli(
      ["status", "--surface", "no-mistakes"],
      fake.env(),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("announce[1]{surface,tool,claim}:");
    expect(result.stdout).toContain(
      "A new version of no-mistakes is available: 1.72.0 -> 1.73.0",
    );
    expect(result.stdout).toContain(
      "  no-mistakes,no-mistakes,true,1.72.0,null,null,false,no-mistakes update,null",
    );
  });

  it("carries opencode's own announcement when configured", async () => {
    const fake = stdEnv();
    fake.writeFake(
      "opencode",
      `if [ "$1" = "--version" ]; then
  echo "1.18.13"
  exit 0
fi
if [ "$1" = "--help" ]; then
  echo "opencode upgrade available 1.18.13 -> 1.19.0"
  exit 0
fi
exit 1`,
    );
    fake.writeConfig({
      surfaces: {
        opencode: {
          tools: [
            {
              name: "opencode",
              announce_args: ["--help"],
              announce_pattern: "opencode upgrade available [^ ]+ -> [^ ]+",
            },
          ],
        },
      },
    });
    const result = await runCli(
      ["status", "--surface", "opencode"],
      fake.env(),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("announce[1]{surface,tool,claim}:");
    expect(result.stdout).toContain(
      "opencode upgrade available 1.18.13 -> 1.19.0",
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
    expect(model.schemaVersion).toBe(3);
    expect(typeof model.generatedAt).toBe("string");
    expect(model.tools).toHaveLength(40);
    const typescript = model.tools.find((row) => row.tool === "typescript");
    expect(typescript).toEqual({
      surface: "npm",
      tool: "typescript",
      installed: true,
      version: "5.6.3",
      latest: "5.7.2",
      tier: "minor",
      in_use: false,
      apply: "npm install -g typescript@latest",
      pin: "npm install -g typescript@5.6.3",
    });
    const ghost = model.tools.find((row) => row.tool === "ghost");
    expect(ghost).toEqual({
      surface: "mise",
      tool: "ghost",
      installed: false,
    });
    const pinned = model.tools.find(
      (row) => row.surface === "gh" && row.tool === "pinned",
    );
    expect(pinned).toEqual({
      surface: "gh",
      tool: "pinned",
      installed: true,
      version: "v0.3.0",
    });
    const reboot = model.tools.find(
      (row) => row.surface === "apt" && row.tool === "reboot-required",
    );
    expect(reboot).toEqual({
      surface: "apt",
      tool: "reboot-required",
      installed: false,
    });
    // New surfaces emit the same normalized shape; absent facts stay absent
    // (no pin the vendor cannot do, no latest no honest probe exposes).
    const gopls = model.tools.find(
      (row) => row.tool === "gopls-lsp@claude-plugins-official",
    );
    expect(gopls).toEqual({
      surface: "claude",
      tool: "gopls-lsp@claude-plugins-official",
      installed: true,
      version: "1.0.0",
      in_use: false,
      apply: "claude plugin update gopls-lsp@claude-plugins-official",
    });
    const annotate = model.tools.find(
      (row) => row.surface === "herdr" && row.tool === "annotate",
    );
    expect(annotate).toEqual({
      surface: "herdr",
      tool: "annotate",
      installed: true,
      version: "0.4.0",
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

describe("AXI output discipline", () => {
  it("rejects stray positionals instead of silently reporting everything", async () => {
    const fake = stdEnv();
    const result = await runCli(["status", "npm"], fake.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "error: Unknown argument `npm` for `status`",
    );
    expect(result.stdout).toContain(
      "Did you mean `upkeep-axi status --surface npm`?",
    );
    expect(result.stdout).toContain("Run `upkeep-axi status --help` for usage");
  });

  it("derives the help from the invocation: scoped with gaps suggests that apply", async () => {
    const fake = stdEnv();
    const result = await runCli(["status", "--surface", "npm"], fake.env());
    expect(result.code).toBe(0);
    // The scoping hint is already done: it never comes back.
    expect(result.stdout).not.toContain("to scope to one surface");
    expect(result.stdout).toContain(
      "Run `upkeep-axi apply npm` to plan its gaps",
    );
    expect(result.stdout).toContain("help[2]:");
  });

  it("never hints apply for apt: a scoped apt gap hints the row's own command", async () => {
    const fake = stdEnv();
    const result = await runCli(["status", "--surface", "apt"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("Run `upkeep-axi apply");
    expect(result.stdout).toContain(
      "Run `sudo apt-get update && sudo apt-get upgrade` yourself: apt is report-only",
    );
    expect(result.stdout).toContain("help[2]:");
  });

  it("skips the apply hint when the only gaps are apt rows", async () => {
    const fake = stdEnv();
    const result = await runCli(
      ["status", "--surface", "apt,skills"],
      fake.env(),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("  apt,ripgrep,");
    expect(result.stdout).not.toContain("Run `upkeep-axi apply");
    expect(result.stdout).toContain("help[1]:");
  });

  it("derives the help from the rows: no gaps drops the update hint", async () => {
    const fake = stdEnv();
    const result = await runCli(
      ["status", "--surface", "skills,herdr"],
      fake.env(),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("Run `upkeep-axi apply");
    expect(result.stdout).not.toContain("to scope to one surface");
    expect(result.stdout).toContain("help[1]:");
  });

  it("summarizes counts by tier, in-use, and skew on every status run", async () => {
    const fake = stdEnv();
    const result = await runCli(["status", "--json"], fake.env());
    expect(result.code).toBe(0);
    const model = JSON.parse(result.stdout) as {
      summary?: Record<string, number>;
      tools: Array<{ tier?: string; in_use?: boolean }>;
    };
    // Counted independently from the rows: only known gaps count.
    const expected: Record<string, number> = {
      tools: model.tools.length,
      gaps: model.tools.filter((row) => row.tier && row.tier !== "none").length,
    };
    for (const tier of ["major", "minor", "patch"] as const) {
      const count = model.tools.filter((row) => row.tier === tier).length;
      if (count > 0) expected[tier] = count;
    }
    const inUse = model.tools.filter((row) => row.in_use === true).length;
    if (inUse > 0) expected.in_use = inUse;
    expect(model.summary).toEqual(expected);
    expect(model.summary?.gaps).toBeGreaterThan(0);
  });

  it("--fields projects every tools[] row, shared by TOON and JSON", async () => {
    const fake = stdEnv();
    const toon = await runCli(
      ["status", "--surface", "npm", "--fields", "surface,tool,tier"],
      fake.env(),
    );
    expect(toon.code).toBe(0);
    expect(toon.stdout).toContain("tools[5]{surface,tool,tier}:");
    expect(toon.stdout).toContain("  npm,typescript,minor");
    const json = await runCli(
      ["status", "--surface", "npm", "--fields", "surface,tool,tier", "--json"],
      fake.env(),
    );
    const model = JSON.parse(json.stdout) as {
      tools: Array<Record<string, unknown>>;
    };
    expect(model.tools).toHaveLength(5);
    // Every row projects to the named fields and nothing else; a field the
    // row leaves absent (npm gone has no tier) stays absent in JSON.
    expect(
      model.tools.every((row) =>
        Object.keys(row).every((key) =>
          ["surface", "tool", "tier"].includes(key),
        ),
      ),
    ).toBe(true);
    expect(model.tools[2]).toEqual({
      surface: "npm",
      tool: "typescript",
      tier: "minor",
    });
  });

  it("--fields preserves the caller's order and drops duplicates", async () => {
    const fake = stdEnv();
    const result = await runCli(
      ["status", "--surface", "npm", "--fields", "tool,surface,tool"],
      fake.env(),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("tools[5]{tool,surface}:");
  });

  it("an unknown field is a usage error naming the valid fields", async () => {
    const fake = stdEnv();
    const result = await runCli(
      ["status", "--surface", "npm", "--fields", "tool,bogus"],
      fake.env(),
    );
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "error: Unknown field `bogus` for `status` rows",
    );
    expect(result.stdout).toContain(
      "Valid fields: surface, tool, installed, version, latest, tier, in_use, apply, pin",
    );
  });

  it("--fields without a list is a usage error", async () => {
    const fake = stdEnv();
    const result = await runCli(["status", "--fields", ""], fake.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "`--fields` requires a comma list of field names",
    );
  });

  it("--fields projects journal records too", async () => {
    const fake = stdEnv();
    await runCli(["apply", "npm", "typescript", "--execute"], fake.env());
    const toon = await runCli(
      ["journal", "--fields", "id,surface,tool"],
      fake.env(),
    );
    expect(toon.code).toBe(0);
    expect(toon.stdout).toContain("records[1]{id,surface,tool}:");
    expect(toon.stdout).toContain("  1,npm,typescript");
    const json = await runCli(
      ["journal", "--fields", "id,surface,tool", "--json"],
      fake.env(),
    );
    const model = JSON.parse(json.stdout) as {
      records: Array<Record<string, unknown>>;
    };
    expect(model.records).toEqual([
      { id: 1, surface: "npm", tool: "typescript" },
    ]);
  });

  it("an unknown journal field is a usage error", async () => {
    const fake = stdEnv();
    const result = await runCli(["journal", "--fields", "nope"], fake.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "error: Unknown field `nope` for `journal` rows",
    );
  });
});

describe("usage errors", () => {
  it("rejects an unknown surface by naming the known ones", async () => {
    const fake = stdEnv();
    const result = await runCli(["status", "--surface", "nope"], fake.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("Unknown surface: nope");
    expect(result.stdout).toContain(
      "Known surfaces: npm, mise, uv, cargo, bun, gh, skills, fnm, apt, claude, codex, opencode, pi, herdr, no-mistakes",
    );
  });

  it("rejects an unknown flag by naming the valid flags", async () => {
    const fake = stdEnv();
    const result = await runCli(["status", "--bogus"], fake.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "error: Unknown flag `--bogus` for `status`",
    );
    expect(result.stdout).toContain(
      "Valid flags for `status`: --json, --surface <id[,id...]>, --since <cursor>, --changed-only, --fields <a,b,c>, --config <path> (--help always allowed)",
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

  it("apply with no selection is a usage error naming both shapes", async () => {
    const fake = stdEnv();
    const result = await runCli(["apply"], fake.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "Name a surface (`upkeep-axi apply npm`) or pass `--all --tier <patch|minor|major>`",
    );
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

  it("runs with defaults when no config file exists", async () => {
    const fake = stdEnv();
    rmSync(fake.configPath);
    const result = await runCli(
      ["status", "--surface", "npm"],
      fake.env({ XDG_CONFIG_HOME: `${fake.root}/empty-xdg` }),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("  npm,left-pad,true,1.3.0,1.3.0,none,");
  });

  it("reads --config over the default path", async () => {
    const fake = stdEnv();
    const alt = `${fake.root}/alt-config.json`;
    writeRawConfig(
      alt,
      JSON.stringify({
        surfaces: {
          mise: { enabled: false },
          uv: { enabled: false },
          apt: { rebootRequiredPath: `${fake.root}/no-reboot-required` },
        },
      }),
    );
    const viaFlag = await runCli(["status", "--config", alt], fake.env());
    expect(viaFlag.code).toBe(0);
    expect(viaFlag.stdout).not.toContain("  mise,");
    expect(viaFlag.stdout).toContain("  npm,");
  });

  it("rejects an explicit --config path that does not exist", async () => {
    const fake = stdEnv();
    const missing = `${fake.root}/nope.json`;
    const result = await runCli(["status", "--config", missing], fake.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(`Config file not found: ${missing}`);
  });

  it("rejects an unknown surface id in config", async () => {
    const fake = stdEnv();
    fake.writeConfig({ surfaces: { npn: { enabled: false } } });
    const result = await runCli(["status"], fake.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "Config `surfaces.npn` is not a known surface (known: npm, mise, uv, cargo, bun, gh, skills, fnm, apt, claude, codex, opencode, pi, herdr, no-mistakes, firstmate)",
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
