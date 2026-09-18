import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encode } from "@toon-format/toon";
import {
  AxiError,
  installSessionStartHooks,
  runAxiCli,
  sessionStartHookStatus,
  type SessionStartHookStatus as HookStatus,
} from "axi-sdk-js";
import {
  buildAmbientModel,
  emptyAmbientModel,
  renderAmbientJson,
  renderAmbientToon,
} from "./ambient.js";
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
  type JournalRecord,
} from "./journal.js";
import {
  SCHEMA_VERSION,
  collapseHome,
  renderApplyJson,
  renderApplyToon,
  renderJournalJson,
  renderJournalToon,
  renderStatusJson,
  renderStatusToon,
  JOURNAL_ROW_FIELDS,
  TOOL_ROW_FIELDS,
} from "./render.js";
import {
  reportOnlySurfaces,
  resolveSurfaces,
  SURFACE_REGISTRY,
} from "./surfaces/index.js";
import {
  defaultSnapshotPath,
  readSnapshot,
  writeSnapshot,
} from "./snapshot.js";
import { collectStatus } from "./status.js";
import { VERSION } from "./version.js";

export const DESCRIPTION =
  "Report workstation update inventory across surfaces.";

/**
 * The registered report-only surfaces, named in help text so the sentence
 * stays true when the next report-only surface lands.
 */
const REPORT_ONLY_IDS = reportOnlySurfaces()
  .map((surface) => surface.id)
  .join(", ");

/** The hook installer's identity: every managed entry carries this marker. */
const HOOK_MARKER = "upkeep-axi";
/** The second entrypoint the hook command runs (no arguments possible). */
const AMBIENT_BIN_NAME = "upkeep-axi-ambient";

export const TOP_HELP = `usage: upkeep-axi [<command>] [flags]
commands[5]:
  status=report the update inventory (the default command)
  apply=plan updates for named surfaces or --all; runs only with --execute
  journal=print the append-only record of executed applies
  setup=install or repair the session-start hooks (\`setup hooks\`)
  ambient=the bounded session-start dashboard (what the hooks inject)
output:
  Default TOON reports, per surface, installed vs available versions, semver tier, in-use, PATH skew ("update not in effect"), the tool's own update announcements, and the exact apply and pin commands. --json emits the same model.
notes[2]:
  apply plans by default; --execute runs each vendor's own updater with fixed arguments, and report-only surfaces (${REPORT_ONLY_IDS}) are never applied.
  \`update\` refuses: upkeep-axi is not published to npm.
flags[3]:
  --surface <id[,id...]>, --config <path>, --json
examples[5]:
  upkeep-axi
  upkeep-axi status
  upkeep-axi apply npm --execute
  upkeep-axi apply --all --tier minor --execute
  upkeep-axi setup hooks
`;

export const STATUS_HELP = `usage: upkeep-axi status [flags]
Report update inventory for every enabled surface: installed and available versions, semver tier, in-use, PATH skew, the tool's own update announcements, and the exact apply and pin commands.
flags[5]:
  --surface <id[,id...]>, --since <cursor>, --changed-only, --fields <a,b,c>, --config <path>, --json
  --since <cursor> (a journal record id or an ISO timestamp) reports rows whose installed version differs from what the journal recorded at the cursor; --changed-only reports rows whose installed version differs from the journal's newest record of them
  --fields <a,b,c> projects every tools[] row to the named fields, in that order: ${TOOL_ROW_FIELDS.join(", ")}
  config: --config <path> or $XDG_CONFIG_HOME/upkeep-axi/config.json (default ~/.config/upkeep-axi/config.json)
examples[6]:
  upkeep-axi status
  upkeep-axi status --surface npm
  upkeep-axi status --surface npm --fields surface,tool,tier
  upkeep-axi status --changed-only
  upkeep-axi status --since 3
  upkeep-axi status --json
`;

export const APPLY_HELP = `usage: upkeep-axi apply [<surface> [tool...]] [--all --tier <patch|minor|major>] [flags]
Plan updates from the same rows status produces; execute only with --execute. --all requires --tier and takes every gap at or below the tier; naming a surface takes every gap it has; naming tools selects them whatever their tier. Report-only surfaces (${REPORT_ONLY_IDS}) are never applied; their status rows carry the exact commands to run yourself.
Every apply delegates to the vendor's own updater with fixed arguments under a per-surface time budget (config applyTimeoutMs, default 900000). A refused delegate is reported verbatim and never retried; one that outruns its budget is left running and reported unconfirmed. A refused or unconfirmed execute exits 1 with every row's outcome on stdout. A surface whose tool is measured in use (herdr agents, no-mistakes runs, the process table) is refused with the reason.
flags[6]:
  --all, --tier <patch|minor|major>, --execute, --full, --config <path>, --json
  --full prints a refused or unconfirmed delegate's output verbatim; the default caps it at 800 characters with a truncation marker naming the total
examples[5]:
  upkeep-axi apply npm
  upkeep-axi apply npm typescript --execute
  upkeep-axi apply --all --tier minor
  upkeep-axi apply --all --tier minor --execute
  upkeep-axi apply npm --json
`;

export const SETUP_HELP = `usage: upkeep-axi setup hooks [--status] [flags]
Install or repair the agent SessionStart hooks (Claude Code, Codex, OpenCode) that show the upkeep-axi dashboard at every session start. --status reports what is installed without writing. The hook runs the bounded ambient dashboard (known gaps and in-use conflicts only), never the full inventory.
flags[2]:
  --status, --json
examples[3]:
  upkeep-axi setup hooks
  upkeep-axi setup hooks --status
  upkeep-axi setup hooks --json
`;

export const AMBIENT_HELP = `usage: upkeep-axi ambient [flags]
The session-start dashboard: known gaps and in-use conflicts only, most severe first, capped at a few lines with the counts pre-computed. This is exactly what the setup hooks inject; run it to preview them. It never probes anything: it reads the inventory the last unfiltered status run saved under $XDG_STATE_HOME/upkeep-axi/status.json, brought up to date with applies journaled since, and says when that inventory is older than a day. Probe failures are counted here and reported verbatim by status.
flags[1]:
  --json
examples[3]:
  upkeep-axi ambient
  upkeep-axi ambient --json
  upkeep-axi setup hooks
`;

export const JOURNAL_HELP = `usage: upkeep-axi journal [flags]
Print the append-only journal of executed applies: one record per surface per tool, with before, after, tier, command, exit, duration_ms, pin, and started_at. Never rotated; the journal lives under $XDG_STATE_HOME/upkeep-axi (default ~/.local/state/upkeep-axi/journal.jsonl).
flags[3]:
  --fields <a,b,c>, --config <path>, --json
  --fields <a,b,c> projects every record to the named fields, in that order: ${JOURNAL_ROW_FIELDS.join(", ")}
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

function requireFlagValue(
  args: string[],
  index: number,
  flag: string,
  spelling: string,
  command: string,
): string {
  const value = args[index];
  if (value === undefined) {
    // The hint names the fixing command with the flag's own placeholder,
    // never a generic help pointer.
    throw new AxiError(`\`${flag}\` requires a value`, "VALIDATION_ERROR", [
      `Run \`upkeep-axi ${command} ${spelling}\``,
    ]);
  }
  return value;
}

/**
 * Parse the `--fields` comma list against a command's row model: unknown
 * fields are usage errors, duplicates collapse, order is preserved.
 */
function parseFields(
  raw: string,
  command: string,
  valid: readonly string[],
): string[] {
  const fields = [
    ...new Set(
      raw
        .split(",")
        .map((field) => field.trim())
        .filter(Boolean),
    ),
  ];
  const unknown = fields.filter((field) => !valid.includes(field));
  if (unknown.length > 0) {
    throw new AxiError(
      `Unknown field \`${unknown[0]}\` for \`${command}\` rows`,
      "VALIDATION_ERROR",
      [
        `Valid fields: ${valid.join(", ")}`,
        `Run \`upkeep-axi ${command} --help\` for usage`,
      ],
    );
  }
  if (fields.length === 0) {
    throw new AxiError(
      "`--fields` requires a comma list of field names",
      "VALIDATION_ERROR",
      [
        `Valid fields: ${valid.join(", ")}`,
        `Run \`upkeep-axi ${command} --help\` for usage`,
      ],
    );
  }
  return fields;
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

/**
 * Parse the shared flag grammar; unknown flags are usage errors. Each
 * valued flag carries its own placeholder spelling so a missing value
 * hints the exact command that fixes it.
 */
function parseFlags(
  args: string[],
  command: string,
  validFlags: string,
  valued: Map<string, string>,
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
      const value = requireFlagValue(
        args,
        index + 1,
        arg,
        "--config <path>",
        command,
      );
      index++;
      parsed.configPath = value;
      continue;
    }
    const spelling = valued.get(arg);
    if (spelling !== undefined) {
      const value = requireFlagValue(args, index + 1, arg, spelling, command);
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
    "--json, --surface <id[,id...]>, --since <cursor>, --changed-only, --fields <a,b,c>, --config <path>",
    new Map([
      ["--surface", "--surface <id[,id...]>"],
      ["--since", "--since <cursor>"],
      ["--fields", "--fields <a,b,c>"],
    ]),
    new Set(["--changed-only"]),
  );
  // Stray positionals fail loud: `status npm` almost certainly meant
  // `status --surface npm`, and silence would report the wrong scope.
  if (parsed.positionals.length > 0) {
    throw new AxiError(
      `Unknown argument \`${parsed.positionals[0]}\` for \`status\``,
      "VALIDATION_ERROR",
      [
        `Did you mean \`upkeep-axi status --surface ${parsed.positionals[0]}\`?`,
        "Run `upkeep-axi status --help` for usage",
      ],
    );
  }
  const fields =
    parsed.values.get("--fields") !== undefined
      ? parseFields(
          parsed.values.get("--fields") as string,
          "status",
          TOOL_ROW_FIELDS,
        )
      : undefined;
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
  const env = process.env;
  const config = loadValidatedConfig(parsed.configPath);
  const surfaces = resolveSurfaces(surfaceFilter);
  const cursor = since !== undefined ? parseCursor(since, env) : undefined;
  const narrowed = cursor !== undefined || changedOnly;
  const records = narrowed ? readJournal(defaultJournalPath(env)) : [];
  const tools = await collectStatus(config, surfaces, env);
  const generatedAt = new Date().toISOString();
  const extraHelp: string[] = [];
  if (surfaceFilter === undefined) {
    const snapshotPath = defaultSnapshotPath(env);
    try {
      writeSnapshot(snapshotPath, {
        generatedAt,
        schemaVersion: SCHEMA_VERSION,
        tools,
      });
    } catch (error) {
      extraHelp.push(
        `Could not save the inventory for the ambient dashboard at ${collapseHome(snapshotPath)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  let filtered = tools;
  if (cursor) {
    filtered = filterToolsByDrift(
      tools,
      versionsAtCursor(recordsSince(records, cursor)),
    );
  } else if (changedOnly && records.length > 0) {
    // An empty journal is no baseline: the first check reports everything,
    // and later checks narrow to rows that drifted from the journal's last
    // word on them.
    filtered = filterToolsByDrift(tools, versionsAfterNewest(records));
  }
  const report = {
    generatedAt,
    schemaVersion: SCHEMA_VERSION,
    tools: filtered,
  };
  return parsed.json
    ? renderStatusJson(report, { fields })
    : renderStatusToon(
        report,
        context?.binPath ?? process.argv[1] ?? "upkeep-axi",
        DESCRIPTION,
        {
          fields,
          scoped: surfaceFilter !== undefined,
          singleSurface:
            surfaceFilter !== undefined && surfaceFilter.length === 1
              ? surfaceFilter[0]
              : undefined,
          extraHelp,
          ...(narrowed
            ? {
                emptyHelp: [
                  // Given both, --since decides: the cursor wording is the
                  // cursor's; --changed-only names its own baseline.
                  cursor
                    ? "Nothing changed since the cursor"
                    : "Nothing changed since the journal's newest records",
                  "Run `upkeep-axi status` for the full inventory",
                ],
              }
            : {}),
        },
      );
}

/**
 * The version each tool had at the cursor: the `before` of its first record
 * after the cursor. Tools with no record after the cursor have no known
 * state at the cursor and are absent.
 */
function versionsAtCursor(
  after: JournalRecord[],
): Map<string, string | undefined> {
  const at = new Map<string, string | undefined>();
  for (const record of after) {
    if (!at.has(recordKey(record))) at.set(recordKey(record), record.before);
  }
  return at;
}

/** The version each tool had after its newest record: `after`, else `before`. */
function versionsAfterNewest(
  records: JournalRecord[],
): Map<string, string | undefined> {
  const at = new Map<string, string | undefined>();
  for (const record of records) {
    at.set(recordKey(record), record.after ?? record.before);
  }
  return at;
}

/**
 * The rows whose installed version differs from the baseline the journal
 * gives them: an apply that took effect, one that took effect late, or a
 * change made outside upkeep-axi. A refused apply changes nothing and is
 * not reported; rows without a baseline are not reported.
 */
function filterToolsByDrift<
  T extends { surface: string; tool: string; version?: string },
>(tools: T[], baseline: Map<string, string | undefined>): T[] {
  return tools.filter(
    (tool) =>
      baseline.has(recordKey(tool)) &&
      baseline.get(recordKey(tool)) !== tool.version,
  );
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
      [
        "Run `upkeep-axi apply <surface>`",
        "Run `upkeep-axi apply --all --tier <patch|minor|major>`",
      ],
    );
  }
  if (tier !== undefined) {
    throw new AxiError(
      "`--tier` is only valid with `--all`",
      "VALIDATION_ERROR",
      [
        "Name a surface or tools alone, or use --all --tier <patch|minor|major>",
      ],
    );
  }
  return { all: false, surface: positionals[0], tools: positionals.slice(1) };
}

async function applyCommand(
  args: string[],
  context?: CliContext,
): Promise<string> {
  assertNotRoot();
  const parsed = parseFlags(
    args,
    "apply",
    "--all, --tier <patch|minor|major>, --execute, --full, --config <path>, --json",
    new Map([["--tier", "--tier <patch|minor|major>"]]),
    new Set(["--all", "--execute", "--full"]),
  );
  const selection = parseApplySelection(
    parsed.positionals,
    parsed.values,
    parsed.flags,
  );
  // A report-only surface is named for apply never, whatever else was
  // asked: the refusal quotes the row's manual command from the surface's
  // own metadata, never a surface name.
  if (!selection.all) {
    const surface = SURFACE_REGISTRY.find(
      (candidate) => candidate.id === selection.surface,
    );
    if (surface?.reportOnly) {
      throw new AxiError(
        `${surface.id} is report-only: upkeep-axi never runs ${surface.id}, even with sudo`,
        "VALIDATION_ERROR",
        [
          `Run the \`${surface.reportOnly.manualCommand}\` command from status yourself`,
        ],
      );
    }
  }
  const env = process.env;
  const config = loadValidatedConfig(parsed.configPath);
  const { plan, skipped } = await buildPlan(config, selection, env);
  const binPath = context?.binPath ?? process.argv[1] ?? "upkeep-axi";
  const full = parsed.flags.has("--full");
  const renderOptions = {
    full,
    selection,
    ...(plan.length === 0
      ? {
          emptyPlanHelp: [
            selection.all
              ? `Nothing to apply: no known gaps at or below ${selection.tier}`
              : "Nothing to apply: every selected row was skipped; see the skipped block",
            "Run `upkeep-axi status` to see every surface and its apply commands",
          ],
        }
      : {}),
  };
  const render = (report: ApplyReport) =>
    parsed.json
      ? renderApplyJson(report, renderOptions)
      : renderApplyToon(report, binPath, DESCRIPTION, renderOptions);
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
  // The captain's ruling: a refused or unconfirmed delegate is not a
  // success. Exit 1 while every row's outcome stays on stdout - report and
  // let the caller decide.
  if (results.some((row) => row.outcome !== "applied")) {
    process.exitCode = 1;
  }
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

/**
 * The hook target: the sibling ambient entrypoint of the running build. The
 * SDK's hook commands carry no arguments, so the dashboard lives behind its
 * own entrypoint; deriving it from this module's built location keeps the
 * installed command pointing at the same build that ran setup.
 */
export function ambientEntrypointPath(): string {
  return fileURLToPath(
    new URL("../bin/upkeep-axi-ambient.js", import.meta.url),
  );
}

interface HooksModel {
  generatedAt: string;
  schemaVersion: number;
  hooks: Array<{ agent: string; installed: boolean; path: string }>;
  codexFeature: { enabled: boolean; path: string };
  errors?: string[];
}

function hooksModel(status: HookStatus, homeDir?: string): HooksModel {
  const model: HooksModel = {
    generatedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    hooks: [
      {
        agent: "claude",
        installed: status.claude.installed,
        path: collapseHome(status.claude.path, homeDir),
      },
      {
        agent: "codex",
        installed: status.codex.installed,
        path: collapseHome(status.codex.path, homeDir),
      },
      {
        agent: "opencode",
        installed: status.opencode.installed,
        path: collapseHome(status.opencode.path, homeDir),
      },
    ],
    codexFeature: {
      enabled: status.codex.userFeatureEnabled,
      path: collapseHome(status.codex.userFeaturePath, homeDir),
    },
  };
  return model;
}

function renderHooksToon(
  model: HooksModel,
  binPath: string,
  afterInstall: boolean,
): string {
  const body: Record<string, unknown> = {
    bin: collapseHome(binPath),
    description: DESCRIPTION,
    generatedAt: model.generatedAt,
    schemaVersion: model.schemaVersion,
    hooks: model.hooks,
  };
  body.codexFeature = model.codexFeature;
  if (model.errors) body.errors = model.errors;
  const help: string[] = [];
  if (!afterInstall) {
    help.push("Run `upkeep-axi setup hooks` to install or repair the hooks");
  }
  help.push("Restart your agent session to receive upkeep-axi ambient context");
  if (!model.codexFeature.enabled) {
    help.push(
      "Codex needs `[features] hooks = true` in its config.toml; run `upkeep-axi setup hooks` (without --status) to set it",
    );
  }
  return `${encode(body)}\nhelp[${help.length}]:\n${help
    .map((hint) => `  ${hint}`)
    .join("\n")}`;
}

async function setupCommand(
  args: string[],
  context?: CliContext,
): Promise<string> {
  assertNotRoot();
  const action = args[0];
  const stray = args.find((arg, index) => index > 0 && !arg.startsWith("--"));
  if (action !== "hooks" || (action === "hooks" && stray !== undefined)) {
    const complaint =
      action === undefined
        ? "Name what to set up"
        : action === "hooks"
          ? `Unknown argument \`${stray}\` for \`setup hooks\``
          : `Unknown setup action \`${action}\``;
    throw new AxiError(complaint, "VALIDATION_ERROR", [
      "Run `upkeep-axi setup hooks` to install the session-start hooks",
    ]);
  }
  const parsed = parseFlags(
    args.slice(1),
    "setup hooks",
    "--status, --json",
    new Map(),
    new Set(["--status"]),
  );
  const binPath = context?.binPath ?? process.argv[1] ?? "upkeep-axi";
  if (parsed.flags.has("--status")) {
    const status = sessionStartHookStatus({ marker: HOOK_MARKER });
    const model = hooksModel(status);
    return parsed.json
      ? JSON.stringify(model, null, 2)
      : renderHooksToon(model, binPath, false);
  }
  const entrypoint = ambientEntrypointPath();
  if (!existsSync(entrypoint)) {
    throw new AxiError(
      `The ambient entrypoint is not built: ${entrypoint}`,
      "VALIDATION_ERROR",
      ["Run `npm run build` in the upkeep-axi checkout, then run setup again"],
    );
  }
  const errors: string[] = [];
  installSessionStartHooks({
    marker: HOOK_MARKER,
    execPath: entrypoint,
    binaryNames: [AMBIENT_BIN_NAME],
    onError: (message) => errors.push(message),
  });
  const status = sessionStartHookStatus({ marker: HOOK_MARKER });
  const model = hooksModel(status);
  if (errors.length > 0) model.errors = errors;
  return parsed.json
    ? JSON.stringify(model, null, 2)
    : renderHooksToon(model, binPath, true);
}

async function ambientCommand(
  args: string[],
  context?: CliContext,
): Promise<string> {
  assertNotRoot();
  const parsed = parseFlags(args, "ambient", "--json", new Map(), new Set());
  if (parsed.positionals.length > 0) {
    throw new AxiError(
      `Unknown argument \`${parsed.positionals[0]}\` for \`ambient\``,
      "VALIDATION_ERROR",
      ["Run `upkeep-axi ambient`"],
    );
  }
  const env = process.env;
  const now = new Date();
  const snapshot = readSnapshot(defaultSnapshotPath(env));
  const model = snapshot
    ? buildAmbientModel(
        snapshot,
        recordsSince(readJournal(defaultJournalPath(env)), {
          kind: "time",
          at: new Date(snapshot.generatedAt),
        }),
        now.toISOString(),
      )
    : emptyAmbientModel(now.toISOString());
  return parsed.json
    ? renderAmbientJson(model)
    : renderAmbientToon(
        model,
        context?.binPath ?? process.argv[1] ?? "upkeep-axi",
        DESCRIPTION,
      );
}

async function journalCommand(
  args: string[],
  context?: CliContext,
): Promise<string> {
  assertNotRoot();
  const parsed = parseFlags(
    args,
    "journal",
    "--json, --fields <a,b,c>, --config <path>",
    new Map([["--fields", "--fields <a,b,c>"]]),
    new Set(),
  );
  if (parsed.positionals.length > 0) {
    throw new AxiError(
      `Unknown argument \`${parsed.positionals[0]}\` for \`journal\``,
      "VALIDATION_ERROR",
      ["Run `upkeep-axi journal`"],
    );
  }
  const records = readJournal(defaultJournalPath(process.env));
  const report = {
    generatedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    records,
  };
  const fieldsOption =
    parsed.values.get("--fields") !== undefined
      ? {
          fields: parseFields(
            parsed.values.get("--fields") as string,
            "journal",
            JOURNAL_ROW_FIELDS,
          ),
        }
      : {};
  return parsed.json
    ? renderJournalJson(report, fieldsOption)
    : renderJournalToon(
        report,
        context?.binPath ?? process.argv[1] ?? "upkeep-axi",
        DESCRIPTION,
        fieldsOption,
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
      setup: setupCommand,
      ambient: ambientCommand,
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
            : command === "setup"
              ? SETUP_HELP
              : command === "ambient"
                ? AMBIENT_HELP
                : undefined,
  });
}
