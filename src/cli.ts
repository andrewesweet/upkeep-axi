import { existsSync } from "node:fs";
import { AxiError, runAxiCli } from "axi-sdk-js";
import {
  buildPlan,
  executePlan,
  isApplyTier,
  type ApplyReport,
  type ApplySelection,
  type ApplyTier,
} from "./apply.js";
import { defaultConfigPath, loadConfig } from "./config.js";
import { assertNotRoot } from "./exec.js";
import {
  defaultJournalPath,
  parseCursor,
  readJournal,
  recordKey,
  recordsSince,
} from "./journal.js";
import {
  SCHEMA_VERSION,
  renderApplyJson,
  renderApplyToon,
  renderJournalJson,
  renderJournalToon,
  renderStatusJson,
  renderStatusToon,
} from "./render.js";
import { resolveSurfaces } from "./surfaces/index.js";
import { collectStatus } from "./status.js";
import { VERSION } from "./version.js";

export const DESCRIPTION =
  "Report workstation update inventory across surfaces.";

export const TOP_HELP = `usage: upkeep-axi [<command>] [flags]
commands[3]:
  status=report the update inventory (the default command)
  apply=plan updates for named surfaces or --all; runs only with --execute
  journal=print the append-only record of executed applies
output:
  Default TOON reports, per surface, installed vs available versions, semver tier, in-use, PATH skew ("update not in effect"), the tool's own update announcements, and the exact apply and pin commands. --json emits the same model.
notes[2]:
  apply plans by default; --execute runs each vendor's own updater with fixed arguments, and apt is never applied.
  \`update\` refuses: upkeep-axi is not published to npm.
flags[3]:
  --surface <id[,id...]>, --config <path>, --json
examples[4]:
  upkeep-axi
  upkeep-axi status
  upkeep-axi apply npm --execute
  upkeep-axi apply --all --tier minor --execute
`;

export const STATUS_HELP = `usage: upkeep-axi status [flags]
Report update inventory for every enabled surface: installed and available versions, semver tier, in-use, PATH skew, the tool's own update announcements, and the exact apply and pin commands.
flags[4]:
  --surface <id[,id...]>, --since <cursor>, --changed-only, --config <path>, --json
  --since takes a journal record id or an ISO timestamp; --changed-only means since the newest record
  config: --config <path> or $XDG_CONFIG_HOME/upkeep-axi/config.json (default ~/.config/upkeep-axi/config.json)
examples[5]:
  upkeep-axi status
  upkeep-axi status --surface npm
  upkeep-axi status --changed-only
  upkeep-axi status --since 3
  upkeep-axi status --json
`;

export const APPLY_HELP = `usage: upkeep-axi apply [<surface> [tool...]] [--all --tier <patch|minor|major>] [flags]
Plan updates from the same rows status produces; execute only with --execute. --all requires --tier and takes every gap at or below the tier; naming a surface defaults the tier to major; naming tools selects them whatever their tier. apt is report-only and never applied.
Every apply delegates to the vendor's own updater with fixed arguments under a per-surface time budget (config applyTimeoutMs, default 900000). A refused delegate is reported verbatim and never retried; one that outruns its budget is left running and reported unconfirmed. A surface whose tool is measured in use (herdr agents, no-mistakes runs, the process table) is refused with the reason.
flags[5]:
  --all, --tier <patch|minor|major>, --execute, --config <path>, --json
examples[6]:
  upkeep-axi apply npm
  upkeep-axi apply npm typescript --execute
  upkeep-axi apply npm --tier patch --execute
  upkeep-axi apply --all --tier minor
  upkeep-axi apply --all --tier minor --execute
  upkeep-axi apply npm --json
`;

export const JOURNAL_HELP = `usage: upkeep-axi journal [flags]
Print the append-only journal of executed applies: one record per surface per tool, with before, after, tier, command, exit, duration_ms, pin, and started_at. Never rotated; the journal lives under $XDG_STATE_HOME/upkeep-axi (default ~/.local/state/upkeep-axi/journal.jsonl).
flags[2]:
  --config <path>, --json
examples[2]:
  upkeep-axi journal
  upkeep-axi journal --json
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
  if (first === "status" || first === "apply" || first === "journal")
    return raw;
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
      `Run \`upkeep-axi --help\` for usage`,
    ]);
  }
  return value;
}

interface ParsedArgs {
  json: boolean;
  configPath?: string;
  positionals: string[];
  /** Valued flags: --surface, --since, --tier. */
  values: Map<string, string>;
  /** Boolean flags: --all, --execute, --changed-only. */
  flags: Set<string>;
}

/** Parse the shared flag grammar; unknown flags are usage errors. */
function parseFlags(
  args: string[],
  command: string,
  validFlags: string,
  valued: Set<string>,
  boolean: Set<string>,
): ParsedArgs {
  const parsed: ParsedArgs = {
    json: false,
    positionals: [],
    values: new Map(),
    flags: new Set(),
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--config") {
      const value = requireFlagValue(args, index + 1, arg);
      index++;
      parsed.configPath = value;
      continue;
    }
    if (valued.has(arg)) {
      const value = requireFlagValue(args, index + 1, arg);
      index++;
      parsed.values.set(arg, value);
      continue;
    }
    if (boolean.has(arg)) {
      parsed.flags.add(arg);
      continue;
    }
    if (!arg.startsWith("-")) {
      parsed.positionals.push(arg);
      continue;
    }
    throw new AxiError(
      `Unknown flag \`${arg}\` for \`${command}\``,
      "VALIDATION_ERROR",
      [
        `Valid flags for \`${command}\`: ${validFlags} (--help always allowed)`,
        `Run \`upkeep-axi ${command} --help\``,
      ],
    );
  }
  return parsed;
}

function loadValidatedConfig(configPath: string | undefined) {
  if (configPath !== undefined && !existsSync(configPath)) {
    throw new AxiError(
      `Config file not found: ${configPath}`,
      "VALIDATION_ERROR",
      ["Pass --config <path> to an existing file, or omit it for the default"],
    );
  }
  return loadConfig(configPath ?? defaultConfigPath());
}

async function statusCommand(
  args: string[],
  context?: CliContext,
): Promise<string> {
  assertNotRoot();
  const parsed = parseFlags(
    args,
    "status",
    "--json, --surface <id[,id...]>, --since <cursor>, --changed-only, --config <path>",
    new Set(["--surface", "--since"]),
    new Set(["--changed-only"]),
  );
  let surfaceFilter: string[] | undefined;
  const surfaceValue = parsed.values.get("--surface");
  if (surfaceValue !== undefined) {
    surfaceFilter = surfaceValue
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
  }
  const since = parsed.values.get("--since");
  const changedOnly = parsed.flags.has("--changed-only");
  if (since !== undefined && changedOnly) {
    throw new AxiError(
      "Pass either `--since <cursor>` or `--changed-only`, not both",
      "VALIDATION_ERROR",
      ["Run `upkeep-axi status --help` for usage"],
    );
  }
  const env = process.env;
  const config = loadValidatedConfig(parsed.configPath);
  const surfaces = resolveSurfaces(surfaceFilter);
  let cursor: ReturnType<typeof parseCursor> | undefined;
  if (since !== undefined) {
    cursor = parseCursor(since, env);
  } else if (changedOnly) {
    const records = readJournal(defaultJournalPath(env));
    // An empty journal is no baseline: the first daily check reports
    // everything, and only later checks narrow to what changed.
    if (records.length > 0) {
      cursor = { kind: "id", id: records.at(-1)?.id ?? 0 };
    }
  }
  const tools = await collectStatus(config, surfaces, env);
  const filtered = cursor
    ? filterToolsByJournal(
        tools,
        recordsSince(readJournal(defaultJournalPath(env)), cursor),
      )
    : tools;
  const report = {
    generatedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    tools: filtered,
  };
  return parsed.json
    ? renderStatusJson(report)
    : renderStatusToon(
        report,
        context?.binPath ?? process.argv[1] ?? "upkeep-axi",
        DESCRIPTION,
        cursor
          ? {
              emptyHelp: [
                "Nothing changed since the cursor",
                "Run `upkeep-axi status` for the full inventory",
              ],
            }
          : undefined,
      );
}

/** The surfaces whose latest or installed changed: those the journal names. */
function filterToolsByJournal<T extends { surface: string; tool: string }>(
  tools: T[],
  records: Array<{ surface: string; tool: string }>,
): T[] {
  if (records.length === 0) return [];
  const changed = new Set(records.map(recordKey));
  return tools.filter((tool) => changed.has(recordKey(tool)));
}

function parseApplySelection(
  positionals: string[],
  values: Map<string, string>,
  flags: Set<string>,
): ApplySelection {
  const tierRaw = values.get("--tier");
  const all = flags.has("--all");
  let tier: ApplyTier | undefined;
  if (tierRaw !== undefined) {
    if (!isApplyTier(tierRaw)) {
      throw new AxiError(
        `Invalid --tier value: ${tierRaw}`,
        "VALIDATION_ERROR",
        ["--tier takes patch, minor, or major"],
      );
    }
    tier = tierRaw;
  }
  if (all) {
    if (positionals.length > 0) {
      throw new AxiError(
        "`--all` takes no surface or tool names",
        "VALIDATION_ERROR",
        [
          "Name a surface (`upkeep-axi apply npm`) or use --all --tier <patch|minor|major>",
        ],
      );
    }
    if (tier === undefined) {
      throw new AxiError(
        "`--all` requires `--tier <patch|minor|major>`",
        "VALIDATION_ERROR",
        [
          "Run `upkeep-axi apply --all --tier minor` to plan every gap at or below minor",
        ],
      );
    }
    return { all: true, tier };
  }
  if (positionals.length === 0) {
    throw new AxiError(
      "Name a surface (`upkeep-axi apply npm`) or pass `--all --tier <patch|minor|major>`",
      "VALIDATION_ERROR",
      ["Run `upkeep-axi apply --help` for usage"],
    );
  }
  if (tier !== undefined && positionals.length > 1) {
    throw new AxiError(
      "`--tier` does not narrow explicitly named tools",
      "VALIDATION_ERROR",
      ["Name tools alone, or filter the surface with --tier"],
    );
  }
  return {
    all: false,
    tier,
    surface: positionals[0],
    tools: positionals.slice(1),
  };
}

async function applyCommand(
  args: string[],
  context?: CliContext,
): Promise<string> {
  assertNotRoot();
  const parsed = parseFlags(
    args,
    "apply",
    "--all, --tier <patch|minor|major>, --execute, --config <path>, --json",
    new Set(["--tier"]),
    new Set(["--all", "--execute"]),
  );
  const selection = parseApplySelection(
    parsed.positionals,
    parsed.values,
    parsed.flags,
  );
  // apt is report-only: naming it for apply is a usage error, whatever
  // else was asked.
  if (!selection.all && selection.surface === "apt") {
    throw new AxiError(
      "apt is report-only: upkeep-axi never runs apt, even with sudo",
      "VALIDATION_ERROR",
      [
        "Run the `sudo apt-get update && sudo apt-get upgrade` command from status yourself",
      ],
    );
  }
  const env = process.env;
  const config = loadValidatedConfig(parsed.configPath);
  const { plan, skipped } = await buildPlan(config, selection, env);
  const binPath = context?.binPath ?? process.argv[1] ?? "upkeep-axi";
  const render = (report: ApplyReport) =>
    parsed.json
      ? renderApplyJson(report)
      : renderApplyToon(report, binPath, DESCRIPTION);
  if (!parsed.flags.has("--execute")) {
    return render({
      generatedAt: new Date().toISOString(),
      schemaVersion: SCHEMA_VERSION,
      mode: "plan",
      plan,
      skipped,
    });
  }
  const { results, output } = await executePlan(config, plan, env);
  return render({
    generatedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    mode: "executed",
    plan,
    skipped,
    results,
    output,
  });
}

async function journalCommand(
  args: string[],
  context?: CliContext,
): Promise<string> {
  assertNotRoot();
  const parsed = parseFlags(
    args,
    "journal",
    "--json, --config <path>",
    new Set(),
    new Set(),
  );
  if (parsed.positionals.length > 0) {
    throw new AxiError(
      `Unknown argument \`${parsed.positionals[0]}\` for \`journal\``,
      "VALIDATION_ERROR",
      ["Run `upkeep-axi journal --help` for usage"],
    );
  }
  const records = readJournal(defaultJournalPath(process.env));
  const report = {
    generatedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    records,
  };
  return parsed.json
    ? renderJournalJson(report)
    : renderJournalToon(
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
      apply: applyCommand,
      journal: journalCommand,
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
      command === "status"
        ? STATUS_HELP
        : command === "apply"
          ? APPLY_HELP
          : command === "journal"
            ? JOURNAL_HELP
            : undefined,
  });
}
