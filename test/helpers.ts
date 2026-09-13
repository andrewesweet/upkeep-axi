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
  configPath: string;
  writeFake(name: string, body: string): void;
  writeFakeIn(dir: string, name: string, body: string): void;
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
  const configPath = join(xdgDir, "upkeep-axi", "config.json");
  const writeFakeIn = (dir: string, name: string, body: string) => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  return {
    root,
    binDir,
    xdgDir,
    configPath,
    writeFake: (name, body) => writeFakeIn(binDir, name, body),
    writeFakeIn,
    writeConfig: (config) => {
      writeFakeConfigAt(configPath, config);
      return configPath;
    },
    env: (extra = {}) => ({
      PATH: binDir,
      HOME: root,
      XDG_CONFIG_HOME: xdgDir,
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
  env.writeFake(
    "npm",
    `if [ "$1" = "ls" ]; then
  echo '{"dependencies":{"left-pad":{"version":"1.3.0"},"esbuild":{"version":"0.20.0"},"typescript":{"version":"5.6.3"},"unparsable":{"version":"dev"},"gone":{"version":"2.0.0"}}}'
  exit 0
fi
if [ "$1" = "view" ]; then
  case "$2" in
    left-pad) echo "1.3.0" ;;
    esbuild) echo "0.20.0" ;;
    typescript) echo "5.7.2" ;;
    unparsable) echo "2026.09.0" ;;
    gone) echo "" ;;
  esac
  exit 0
fi
exit 1`,
  );
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
}
