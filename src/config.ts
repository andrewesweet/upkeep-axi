import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { SURFACE_REGISTRY } from "./surfaces/index.js";
import type { SurfaceConfig, UpkeepConfig } from "./types.js";

/**
 * The tool-owned config file: `$XDG_CONFIG_HOME/upkeep-axi/config.json`
 * (default `~/.config/upkeep-axi/config.json`), installed by host-up.
 */
export function defaultConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const xdg = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "upkeep-axi", "config.json");
}
/**
 * Load and validate the config. A missing default file is the default config:
 * every registry surface enabled, no per-tool entries (an explicit --config
 * path must exist; the CLI checks that). A malformed file is a usage
 * error, never silently ignored.
 */
export function loadConfig(path: string): UpkeepConfig {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new AxiError(
      `Config file is not valid JSON: ${path}`,
      "VALIDATION_ERROR",
      [
        `Fix the JSON in ${path} or pass --config <path> with a valid file`,
        error instanceof Error ? error.message : String(error),
      ],
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AxiError(
      `Config root must be a JSON object: ${path}`,
      "VALIDATION_ERROR",
    );
  }
  const root = parsed as { surfaces?: unknown };
  if (root.surfaces === undefined) return {};
  if (
    root.surfaces === null ||
    typeof root.surfaces !== "object" ||
    Array.isArray(root.surfaces)
  ) {
    throw new AxiError(
      `Config \`surfaces\` must be an object keyed by surface id: ${path}`,
      "VALIDATION_ERROR",
    );
  }
  const known = SURFACE_REGISTRY.map((surface) => surface.id);
  const surfaces: Record<string, SurfaceConfig> = {};
  for (const [id, value] of Object.entries(
    root.surfaces as Record<string, unknown>,
  )) {
    if (!known.includes(id)) {
      throw configError(
        `surfaces.${id}`,
        `is not a known surface (known: ${known.join(", ")})`,
        path,
      );
    }
    surfaces[id] = validateSurface(id, value, path);
  }
  return { surfaces };
}

function validateSurface(
  id: string,
  value: unknown,
  path: string,
): SurfaceConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw configError(`surfaces.${id}`, "must be an object", path);
  }
  const entry = value as Record<string, unknown>;
  if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
    throw configError(`surfaces.${id}.enabled`, "must be a boolean", path);
  }
  if (
    entry.rebootRequiredPath !== undefined &&
    !isNonEmptyString(entry.rebootRequiredPath)
  ) {
    throw configError(
      `surfaces.${id}.rebootRequiredPath`,
      "must be a non-empty string",
      path,
    );
  }
  if (
    entry.applyTimeoutMs !== undefined &&
    (typeof entry.applyTimeoutMs !== "number" ||
      !Number.isInteger(entry.applyTimeoutMs) ||
      entry.applyTimeoutMs <= 0)
  ) {
    throw configError(
      `surfaces.${id}.applyTimeoutMs`,
      "must be a positive integer (milliseconds)",
      path,
    );
  }
  for (const field of [
    "clonePath",
    "upstreamRemote",
    "forkRemote",
    "defaultBranch",
  ] as const) {
    if (entry[field] !== undefined && !isNonEmptyString(entry[field])) {
      throw configError(
        `surfaces.${id}.${field}`,
        "must be a non-empty string",
        path,
      );
    }
  }
  if (entry.tools !== undefined) {
    if (!Array.isArray(entry.tools)) {
      throw configError(`surfaces.${id}.tools`, "must be an array", path);
    }
    entry.tools.forEach((tool, index) =>
      validateTool(`surfaces.${id}.tools[${index}]`, tool, path),
    );
  }
  return entry as SurfaceConfig;
}

function validateTool(where: string, value: unknown, path: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw configError(where, "must be an object", path);
  }
  const tool = value as Record<string, unknown>;
  if (!isNonEmptyString(tool.name)) {
    throw configError(`${where}.name`, "must be a non-empty string", path);
  }
  if (tool.command !== undefined && !isNonEmptyString(tool.command)) {
    throw configError(`${where}.command`, "must be a non-empty string", path);
  }
  for (const field of ["version_args", "announce_args"] as const) {
    if (tool[field] !== undefined) {
      if (
        !Array.isArray(tool[field]) ||
        !(tool[field] as unknown[]).every((arg) => typeof arg === "string")
      ) {
        throw configError(
          `${where}.${field}`,
          "must be an array of strings",
          path,
        );
      }
    }
  }
  if (tool.announce_pattern !== undefined) {
    if (!isNonEmptyString(tool.announce_pattern)) {
      throw configError(
        `${where}.announce_pattern`,
        "must be a non-empty string",
        path,
      );
    }
    try {
      new RegExp(tool.announce_pattern);
    } catch (error) {
      throw configError(
        `${where}.announce_pattern`,
        `is not a valid regex: ${error instanceof Error ? error.message : String(error)}`,
        path,
      );
    }
    if (tool.announce_args === undefined) {
      throw configError(
        `${where}.announce_args`,
        "is required when announce_pattern is set",
        path,
      );
    }
  }
  if (tool.git !== undefined) {
    if (
      tool.git === null ||
      typeof tool.git !== "object" ||
      Array.isArray(tool.git)
    ) {
      throw configError(`${where}.git`, "must be an object", path);
    }
    const git = tool.git as Record<string, unknown>;
    if (!isNonEmptyString(git.repo)) {
      throw configError(
        `${where}.git.repo`,
        "must be a non-empty string",
        path,
      );
    }
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function configError(where: string, problem: string, path: string): AxiError {
  return new AxiError(
    `Config \`${where}\` ${problem}: ${path}`,
    "VALIDATION_ERROR",
  );
}
