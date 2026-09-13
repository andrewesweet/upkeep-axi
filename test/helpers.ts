import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "bin",
  "upkeep-axi.js",
);

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * A disposable environment for one test: a fake bin directory that becomes
 * the spawned CLI's whole PATH, and an XDG config root. Real vendor
 * executables are unreachable by construction - the spawned process gets
 * exactly the environment given here, never the parent's.
 */
export interface FakeEnv {
  root: string;
  binDir: string;
  xdgDir: string;
  xdgStateDir: string;
  configPath: string;
  writeFake(name: string, body: string): void;
  writeFakeIn(dir: string, name: string, body: string): void;
  /** Write a plain file under the fake home (state the vendors keep there). */
  writeFakeFile(relPath: string, content: string): void;
  /**
   * Write the default config. The apt reboot-required flag is always pinned
   * to an absent path under root unless the config overrides it, so the
   * spawned CLI never reads the host's real /var/run/reboot-required.
   */
  writeConfig(config: unknown): string;
  /** Base env for runCli; spread extras over it. */
  env(extra?: Record<string, string>): NodeJS.ProcessEnv;
}

export function createEnv(): FakeEnv {
  const root = mkdtempSync(join(tmpdir(), "upkeep-axi-test-"));
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  const xdgDir = join(root, "xdg");
  mkdirSync(xdgDir);
  const xdgStateDir = join(root, "xdg-state");
  mkdirSync(xdgStateDir);
  const configPath = join(xdgDir, "upkeep-axi", "config.json");
  const writeFakeIn = (dir: string, name: string, body: string) => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  const apt = { rebootRequiredPath: join(root, "no-reboot-required") };
  const writeConfig = (config: unknown) => {
    const base = config as { surfaces?: Record<string, unknown> };
    writeFakeConfigAt(configPath, {
      ...base,
      surfaces: { apt, ...base.surfaces },
    });
    return configPath;
  };
  writeConfig({});
  return {
    root,
    binDir,
    xdgDir,
    xdgStateDir,
    configPath,
    writeFake: (name, body) => writeFakeIn(binDir, name, body),
    writeFakeIn,
    writeFakeFile: (relPath, content) => {
      const path = join(root, relPath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    },
    writeConfig,
    env: (extra = {}) => ({
      PATH: binDir,
      HOME: root,
      XDG_CONFIG_HOME: xdgDir,
      XDG_STATE_HOME: xdgStateDir,
      ...extra,
    }),
  };
}

function writeFakeConfigAt(path: string, config: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
}

export function writeRawConfig(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Spawn the built CLI with exactly the given environment. */
export function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
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

/**
 * Scripted vendor fakes covering tiers (none, minor, major, unparseable,
 * unknown latest), a not-installed mise entry, and uv's bin lines. Every
 * fake uses shell builtins only (echo/case/test) because the spawned CLI's
 * PATH contains nothing else - real vendor executables are unreachable by
 * construction.
 */
export function installStandardFakes(env: FakeEnv): void {
  // The npm fake keeps applied installs in a state file under the fake HOME:
  // `install -g name@latest` bumps the version `ls -g` reports, so an apply
  // can be observed end to end. Shell builtins only, as everywhere; the
  // version is spliced into a single-quoted JSON literal.
  env.writeFake(
    "npm",
    `if [ "$1" = "ls" ]; then
  ts=5.6.3
  if test -f "$HOME/.npm-state/typescript"; then read ts < "$HOME/.npm-state/typescript"; fi
  echo '{"dependencies":{"left-pad":{"version":"1.3.0"},"esbuild":{"version":"0.20.0"},"typescript":{"version":"'"$ts"'","bin":{"tsc":"bin/tsc"}},"unparsable":{"version":"dev"},"gone":{"version":"2.0.0"}}}'
  exit 0
fi
if [ "$1" = "view" ]; then
  case "$2" in
    left-pad) echo "1.3.0" ;;
    esbuild) echo "0.20.0" ;;
    typescript) echo "5.7.2" ;;
    unparsable) echo "2026.09.0" ;;
    gone) echo "" ;;
    @openai/codex) echo "0.155.0" ;;
  esac
  exit 0
fi
if [ "$1" = "install" ] && [ "$2" = "-g" ]; then
  name=\${3%@latest}
  case "$name" in
    typescript) echo "5.7.2" > "$HOME/.npm-state/typescript" ;;
  esac
  exit 0
fi
exit 1`,
  );
  // The state directory the install branch writes into (mkdir is not a
  // shell builtin, so the fake cannot create it itself).
  env.writeFakeFile(".npm-state/.keep", "");
  env.writeFake(
    "mise",
    `if [ "$1" = "ls" ]; then
  echo '{"node":[{"version":"20.11.0","installed":true}],"ghost":[{"version":"9.9.9","installed":false}]}'
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
exit 1`,
  );
  env.writeFake(
    "uv",
    `if [ "$1" = "tool" ] && [ "$2" = "list" ] && [ "$3" != "--outdated" ]; then
  echo 'ruff v0.3.4'
  echo '- ruff'
  echo 'zizmor v1.24.1'
  echo '- zizmor'
  exit 0
fi
if [ "$1" = "tool" ] && [ "$2" = "list" ] && [ "$3" = "--outdated" ]; then
  echo 'ruff v0.3.4 [latest: 0.9.0]'
  echo '- ruff'
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "uv 0.12.5"
  exit 0
fi
exit 1`,
  );
  env.writeFake(
    "cargo",
    `if [ "$1" = "install" ] && [ "$2" = "--list" ]; then
  echo 'bacon v3.10.0:'
  echo '    bacon'
  echo 'fd-find v10.2.0:'
  echo '    fd'
  echo 'unsearchable v0.1.0:'
  echo '    unsearchable'
  exit 0
fi
if [ "$1" = "search" ]; then
  case "$2" in
    bacon) echo 'bacon = "3.12.4"    # Guard against missed breakfasts' ;;
    fd-find) echo 'fd-find = "10.2.0"    # simple, fast and user-friendly alternative to find' ;;
  esac
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "cargo 1.89.0 (8ceb2bf 2026-08-11)"
  exit 0
fi
exit 1`,
  );
  env.writeFake(
    "bun",
    `if [ "$1" = "pm" ] && [ "$2" = "ls" ]; then
  echo '/root/.bun/install/global node_modules (42)'
  echo '├── critique@0.1.140'
  echo '└── stale@2.0.0'
  exit 0
fi
if [ "$1" = "pm" ] && [ "$2" = "view" ]; then
  case "$3" in
    critique) echo "0.2.0" ;;
    stale) echo "" ;;
  esac
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "1.3.14"
  exit 0
fi
exit 1`,
  );
  env.writeFake(
    "gh",
    `if [ "$1" = "--version" ]; then
  echo "gh version 2.97.0 (2026-07-31)"
  echo "https://github.com/cli/cli/releases/tag/v2.97.0"
  exit 0
fi
if [ "$1" = "extension" ] && [ "$2" = "list" ]; then
  echo 'gh stack\tgithub/gh-stack\tv0.1.1'
  echo 'gh dash\tdnorth98/gh-dash\tv1.1.0'
  echo 'gh pinned\tmattn/pinned\tv0.3.0'
  exit 0
fi
if [ "$1" = "extension" ] && [ "$2" = "upgrade" ]; then
  echo '[stack]: already up to date'
  echo '[dash]: would have upgraded from v1.1.0 to v1.2.0'
  echo '[pinned]: pinned extensions can not be upgraded'
  exit 0
fi
exit 1`,
  );
  // The skills fake styles its rows with ANSI escapes the way the real CLI
  // does; /bin/sh echo interprets \033, so the parse path is exercised.
  env.writeFake(
    "skills",
    `if [ "$1" = "list" ] && [ "$2" = "-g" ]; then
  echo '\\033[1mGlobal Skills\\033[0m'
  echo ''
  echo '\\033[36mcaveman\\033[0m                           \\033[2m~/.agents/skills/caveman\\033[0m'
  echo '  \\033[2mAgents:\\033[0m Claude Code  \\033[2mSource:\\033[0m mattpocock/skills'
  echo '\\033[36mhandoff\\033[0m                           \\033[2m~/.agents/skills/handoff\\033[0m'
  echo '  \\033[2mAgents:\\033[0m Claude Code  \\033[2mSource:\\033[0m local'
  exit 0
fi
exit 1`,
  );
  env.writeFake(
    "fnm",
    `if [ "$1" = "list" ]; then
  echo '* v24.18.0 default'
  echo '* v22.20.0'
  echo '* system'
  exit 0
fi
if [ "$1" = "ls-remote" ]; then
  echo 'v24.19.0 (Krypton)'
  echo 'v24.20.0 (Krypton)'
  echo 'v24.21.0 (Krypton)'
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "fnm 1.38.2"
  exit 0
fi
exit 1`,
  );
  env.writeFake(
    "apt",
    `if [ "$1" = "list" ] && [ "$2" = "--upgradable" ]; then
  echo "WARNING: apt does not have a stable CLI interface." >&2
  echo 'Listing...'
  echo 'openssl/jammy-updates,jammy-security 3.0.2-0ubuntu1.15 amd64 [upgradable from: 3.0.2-0ubuntu1.14]'
  echo 'ripgrep/nowhere 15.0.0 amd64 [upgradable from: 14.1.1]'
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo "apt 2.8.3 (amd64)"
  exit 0
fi
exit 1`,
  );
  // Claude Code binary plus its own state files: two enabled plugins (one
  // with a manifest version, one with only the installer-recorded version),
  // one enabled but not installed, one disabled, two marketplaces.
  env.writeFake(
    "claude",
    `if [ "$1" = "--version" ]; then
  echo "2.1.270 (Claude Code)"
  exit 0
fi
exit 1`,
  );
  env.writeFakeFile(
    ".claude/settings.json",
    JSON.stringify({
      enabledPlugins: {
        "gopls-lsp@claude-plugins-official": true,
        "context7@claude-plugins-official": true,
        "ghost-plugin@ghost-market": true,
        "caveman@caveman": false,
      },
    }),
  );
  env.writeFakeFile(
    ".claude/plugins/installed_plugins.json",
    JSON.stringify({
      version: 2,
      plugins: {
        "gopls-lsp@claude-plugins-official": [
          {
            scope: "user",
            installPath: `${env.root}/.claude/plugins/cache/claude-plugins-official/gopls-lsp/1.0.0`,
            version: "1.0.0",
          },
        ],
        "context7@claude-plugins-official": [
          {
            scope: "user",
            installPath: `${env.root}/.claude/plugins/cache/claude-plugins-official/context7/3deb821cb71c`,
            version: "3deb821cb71c",
          },
        ],
      },
    }),
  );
  env.writeFakeFile(
    ".claude/plugins/known_marketplaces.json",
    JSON.stringify({
      "claude-plugins-official": {
        installLocation: `${env.root}/.claude/plugins/marketplaces/claude-plugins-official`,
      },
      caveman: {
        installLocation: `${env.root}/.claude/plugins/marketplaces/caveman`,
      },
    }),
  );
  env.writeFake(
    "codex",
    `if [ "$1" = "--version" ]; then
  echo "codex-cli 0.154.0"
  exit 0
fi
exit 1`,
  );
  env.writeFake(
    "opencode",
    `if [ "$1" = "--version" ]; then
  echo "1.18.13"
  exit 0
fi
exit 1`,
  );
  env.writeFake(
    "pi",
    `if [ "$1" = "--version" ]; then
  echo "0.85.1"
  exit 0
fi
if [ "$1" = "list" ]; then
  echo "User:"
  echo "  github:owner/some-pi-ext"
  echo "    ${env.root}/.pi/agent/packages/some-pi-ext"
  exit 0
fi
exit 1`,
  );
  env.writeFake(
    "herdr",
    `if [ "$1" = "--version" ]; then
  echo "herdr 0.9.0"
  exit 0
fi
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  echo '{"id":"cli:agent:list","result":{"agents":[],"type":"agent_list"}}'
  exit 0
fi
exit 1`,
  );
  env.writeFakeFile(
    "xdg/herdr/plugins.json",
    JSON.stringify([
      {
        plugin_id: "annotate",
        name: "Annotate",
        version: "0.4.0",
        enabled: true,
      },
      { plugin_id: "collie", name: "Collie", version: "1.8.0", enabled: false },
    ]),
  );
  env.writeFake(
    "no-mistakes",
    `if [ "$1" = "--version" ]; then
  echo "no-mistakes version v1.72.0 (9fcc865) 2026-09-08T13:12:43Z"
  exit 0
fi
if [ "$1" = "--help" ]; then
  echo "A new version of no-mistakes is available: 1.72.0 -> 1.73.0"
  exit 0
fi
if [ "$1" = "runs" ]; then
  exit 0
fi
if [ "$1" = "update" ]; then
  echo "no-mistakes fake updated"
  exit 0
fi
exit 1`,
  );
}
