import { basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { compareVersions, extractVersion, parseVersion } from "../semver.js";
import { mapLimit, pathCandidates } from "../exec.js";
import type {
  ApplyDelegate,
  PathSkew,
  SurfaceContext,
  ToolConfig,
  ToolStatus,
} from "../types.js";

/** Per-tool entries configured for a surface (possibly none). */
export function configuredEntries(ctx: SurfaceContext): ToolConfig[] {
  return ctx.surface.tools ?? [];
}

/**
 * Merge configured per-tool entries over discovered rows and run the two
 * config-driven probes: PATH skew and the tool's own update announcement.
 *
 * A configured entry with no discovered row reports as installed=false: the
 * manager does not know it. Probes run only for installed rows.
 */
export async function enrichWithConfig(
  ctx: SurfaceContext,
  surfaceId: string,
  rows: ToolStatus[],
): Promise<ToolStatus[]> {
  const entries = configuredEntries(ctx);
  if (entries.length === 0) return rows;
  const known = new Set(rows.map((row) => row.tool));
  const extra: ToolStatus[] = [];
  for (const entry of entries) {
    if (!known.has(entry.name)) {
      extra.push({ surface: surfaceId, tool: entry.name, installed: false });
    }
  }
  const all = [...rows, ...extra];
  await mapLimit(all, 8, async (row) => {
    const entry = entries.find((candidate) => candidate.name === row.tool);
    if (!entry || !row.installed) return;
    row.skew = await probePathSkew(ctx, entry);
    row.announcement = await probeAnnouncement(ctx, entry);
  });
  return all;
}

/**
 * PATH skew is measured, not inferred: every copy of the command on PATH is
 * asked for its version. When a copy behind the resolved one parses newer,
 * the update is not in effect. Fewer than two copies, or an unparseable
 * resolved version, yields no skew data.
 */
export async function probePathSkew(
  ctx: SurfaceContext,
  entry: ToolConfig,
): Promise<PathSkew | undefined> {
  const command = entry.command ?? entry.name;
  const versionArgs = entry.version_args ?? ["--version"];
  const candidates = pathCandidates(command, ctx.env);
  if (candidates.length < 2) return undefined;
  const results = await mapLimit(candidates, 4, (candidate) =>
    ctx.exec(candidate, versionArgs),
  );
  const versions = results.map(
    (result) => extractVersion(result.stdout) ?? extractVersion(result.stderr),
  );
  const resolved = parseVersion(versions[0] ?? "");
  if (!resolved) return undefined;
  let newestIndex = 0;
  let newest = resolved;
  for (let index = 1; index < versions.length; index++) {
    const parsed = parseVersion(versions[index] ?? "");
    if (!parsed) continue;
    if (compareVersions(parsed, newest) > 0) {
      newest = parsed;
      newestIndex = index;
    }
  }
  if (newestIndex === 0) return undefined;
  return {
    command,
    resolvedPath: candidates[0],
    resolvedVersion: versions[0],
    newerPath: candidates[newestIndex],
    newerVersion: versions[newestIndex],
  };
}

/**
 * Run the tool's own command with the configured announce args and match the
 * configured pattern against its output. The match is reported as the tool's
 * own claim; upkeep-axi adds nothing to it and never invents one.
 */
export async function probeAnnouncement(
  ctx: SurfaceContext,
  entry: ToolConfig,
): Promise<string | undefined> {
  if (!entry.announce_pattern || !entry.announce_args) return undefined;
  const command = entry.command ?? entry.name;
  const candidates = pathCandidates(command, ctx.env);
  if (candidates.length === 0) return undefined;
  const result = await ctx.exec(candidates[0], entry.announce_args);
  const text = `${result.stdout}\n${result.stderr}`;
  const match = new RegExp(entry.announce_pattern).exec(text);
  return match ? match[0].trim() : undefined;
}

/** Ask a detected manager its own version via `--version`. */
export async function managerVersion(
  ctx: SurfaceContext,
  managerPath: string,
): Promise<string | undefined> {
  const result = await ctx.exec(managerPath, ["--version"]);
  return extractVersion(result.stdout) ?? extractVersion(result.stderr);
}

/**
 * The row reported when a manager is detected but its inventory read fails:
 * the manager exists, the read failed, and the detail is reported verbatim.
 */
export function managerErrorRow(
  surfaceId: string,
  managerTool: string,
  version: string | undefined,
  detail: string,
): ToolStatus {
  return {
    surface: surfaceId,
    tool: managerTool,
    installed: true,
    version,
    error: detail,
  };
}

/**
 * The command text a delegate names: the executable's basename plus its
 * fixed argv, one step per line joined with `&&`. This is the one spelling:
 * status rows display it, the plan prints it, and the journal records it -
 * all derived from the same declaration, never re-spelled.
 */
export function applyCommandText(delegate: ApplyDelegate): string {
  return delegate.steps
    .map(
      (step) =>
        `${basename(step.file)}${step.args.length ? ` ${step.args.join(" ")}` : ""}`,
    )
    .join(" && ");
}

/** Parse a JSON exec result, returning undefined on any failure. */
export function parseJsonOutput<T>(stdout: string): T | undefined {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    return undefined;
  }
}

/**
 * Read a settings-style JSON file. A missing file is normal (the manager has
 * nothing recorded there); a file that exists but does not parse is distinct,
 * so the caller can report it verbatim instead of losing it as absence.
 */
export function readJsonFile<T>(
  path: string,
): { value: T } | { missing: true } | { invalid: true } {
  if (!existsSync(path)) return { missing: true };
  try {
    return { value: JSON.parse(readFileSync(path, "utf-8")) as T };
  } catch {
    return { invalid: true };
  }
}
