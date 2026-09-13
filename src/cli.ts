import { existsSync } from "node:fs";
import { AxiError, runAxiCli } from "axi-sdk-js";
import { defaultConfigPath, loadConfig } from "./config.js";
import { assertNotRoot } from "./exec.js";
import {
  SCHEMA_VERSION,
  renderStatusJson,
  renderStatusToon,
} from "./render.js";
import { resolveSurfaces } from "./surfaces/index.js";
import { collectStatus } from "./status.js";
import { VERSION } from "./version.js";

export const DESCRIPTION =
  "Report workstation update inventory across surfaces.";

export const TOP_HELP = `usage: upkeep-axi [status] [flags]
commands[1]:
  (none)=status
output:
  Default TOON reports, per surface, installed vs available versions, semver tier, PATH skew ("update not in effect"), the tool's own update announcements, and the exact apply and pin commands. --json emits the same model.
notes[2]:
  Read-only build: status never installs, updates, or removes anything; \`apply\` lands in a later build.
  \`update\` refuses: upkeep-axi is not published to npm.
flags[3]:
  --surface <id[,id...]>, --config <path>, --json
examples[4]:
  upkeep-axi
  upkeep-axi status
  upkeep-axi status --surface npm
  upkeep-axi status --json
`;

export const STATUS_HELP = `usage: upkeep-axi status [flags]
Report update inventory for every enabled surface: installed and available versions, semver tier, PATH skew, the tool's own update announcements, and the exact apply and pin commands.
flags[3]:
  --surface <id[,id...]>, --config <path>, --json
  config: --config <path> or $XDG_CONFIG_HOME/upkeep-axi/config.json (default ~/.config/upkeep-axi/config.json)
examples[4]:
  upkeep-axi status
  upkeep-axi status --surface npm
  upkeep-axi status --surface npm,mise
  upkeep-axi status --json
`;

interface CliContext {
  binPath: string;
}

interface MainOptions {
  argv?: string[];
  stdout?: { write: (chunk: string) => unknown };
  binPath?: string;
}

/**
 * `status` is the implicit default command: `upkeep-axi`,
 * `upkeep-axi --json`, and `upkeep-axi status --json` all report status.
 * runAxiCli routes on argv[0] and rejects a leading flag, so flag-first
 * calls are prefixed with the command name; lone --help and version flags
 * pass through for the SDK to own.
 */
export function normalizeArgv(raw: string[]): string[] {
  if (raw.length === 0) return ["status"];
  const first = raw[0];
  if (first === "status") return raw;
  if (first.startsWith("-")) {
    const lone =
      raw.length === 1 &&
      (first === "--help" ||
        first === "-v" ||
        first === "-V" ||
        first === "--version");
    if (lone) return raw;
    return ["status", ...raw];
  }
  return raw;
}

function requireFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined) {
    throw new AxiError(`\`${flag}\` requires a value`, "VALIDATION_ERROR", [
      `Run \`upkeep-axi status --help\` for usage`,
    ]);
  }
  return value;
}

async function statusCommand(
  args: string[],
  context?: CliContext,
): Promise<string> {
  assertNotRoot();
  let json = false;
  let configPath: string | undefined;
  let surfaceFilter: string[] | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--config" || arg === "--surface") {
      const value = requireFlagValue(args, index + 1, arg);
      index++;
      if (arg === "--config") {
        configPath = value;
      } else {
        surfaceFilter = value
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);
      }
      continue;
    }
    throw new AxiError(
      `Unknown flag \`${arg}\` for \`status\``,
      "VALIDATION_ERROR",
      [
        "Valid flags for `status`: --json, --surface <id[,id...]>, --config <path> (--help always allowed)",
        "Run `upkeep-axi status --help`",
      ],
    );
  }
  if (configPath !== undefined && !existsSync(configPath)) {
    throw new AxiError(
      `Config file not found: ${configPath}`,
      "VALIDATION_ERROR",
      ["Pass --config <path> to an existing file, or omit it for the default"],
    );
  }
  const config = loadConfig(configPath ?? defaultConfigPath());
  const surfaces = resolveSurfaces(surfaceFilter);
  const tools = await collectStatus(config, surfaces, process.env);
  const report = {
    generatedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    tools,
  };
  return json
    ? renderStatusJson(report)
    : renderStatusToon(
        report,
        context?.binPath ?? process.argv[1] ?? "upkeep-axi",
        DESCRIPTION,
      );
}

export async function main(options: MainOptions = {}): Promise<void> {
  const argv = normalizeArgv(options.argv ?? process.argv.slice(2));
  await runAxiCli<CliContext>({
    argv,
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    ...(options.stdout ? { stdout: options.stdout } : {}),
    commands: {
      status: statusCommand,
      // Shadow the SDK's npm self-updater: upkeep-axi is private source, not
      // an npm package, so the built-in `update` would only fail confusingly.
      update: () => {
        throw new AxiError(
          "upkeep-axi is not published to npm; update it from its source repository",
          "UNSUPPORTED",
          ["Pull the repository and build instead"],
        );
      },
    },
    // Never reached (normalizeArgv always routes bare calls to `status`);
    // wiring it keeps the SDK contract.
    home: statusCommand,
    resolveContext: () => ({
      binPath: options.binPath ?? process.argv[1] ?? "upkeep-axi",
    }),
    getCommandHelp: (command) =>
      command === "status" ? STATUS_HELP : undefined,
  });
}
