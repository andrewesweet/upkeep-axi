/**
 * Core data model: configuration, status rows, and the surface module contract.
 *
 * Every configured surface is one module exposing `detect`, `status`, `apply`,
 * and `pin`. This build implements `detect` and `status` only; `apply` and
 * `pin` are declared by the contract and refuse until the apply task lands.
 */

/** Semver gap tier. A gap whose versions do not both parse is `major`. */
export type SemverTier = "none" | "patch" | "minor" | "major";

/**
 * Per-tool entry. Field names match Firstmate's watched-tools schema so both
 * tools describe a tool the same way.
 *
 * - `name`: tool name as the owning manager reports it.
 * - `command`: executable name probed on PATH; defaults to `name`.
 * - `version_args`: argv used to ask a copy of `command` its version;
 *   defaults to `["--version"]`.
 * - `announce_pattern`: regex matched against the tool's own output; a match
 *   is reported as the tool's own update announcement.
 * - `announce_args`: argv used to obtain that output; required with
 *   `announce_pattern`.
 * - `git`: watched-tools schema compatibility; consumed by the Firstmate-fork
 *   surface in a later build.
 */
export interface ToolConfig {
  name: string;
  command?: string;
  version_args?: string[];
  announce_pattern?: string;
  announce_args?: string[];
  git?: { repo: string; remote?: string; branch?: string };
}

export interface SurfaceConfig {
  enabled?: boolean;
  /** Manager executable override; defaults to the surface's own manager. */
  command?: string;
  /** Per-tool entries merged over the surface's discovered tools. */
  tools?: ToolConfig[];
}

export interface UpkeepConfig {
  surfaces?: Record<string, SurfaceConfig>;
}

export interface ExecResult {
  /** Exit code, or null when the process could not be spawned. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the bounded wait elapsed and the probe was killed. */
  timedOut: boolean;
  /** Spawn failure reason, when the process could not be started. */
  spawnError?: string;
}

export interface SurfaceContext {
  config: UpkeepConfig;
  /** This surface's resolved config entry (possibly empty). */
  surface: SurfaceConfig;
  env: NodeJS.ProcessEnv;
  /** Run an executable with fixed argv under a bounded wait. */
  exec(file: string, args: string[], timeoutMs?: number): Promise<ExecResult>;
}

/** Measured PATH skew: a newer copy of `command` sits behind the resolved one. */
export interface PathSkew {
  command: string;
  resolvedPath: string;
  resolvedVersion?: string;
  newerPath: string;
  newerVersion?: string;
}

/** One row per tool per surface. Absent facts stay absent. */
export interface ToolStatus {
  surface: string;
  tool: string;
  installed: boolean;
  /** Installed version, when the manager or a probe reports one. */
  version?: string;
  /** Available version, when the manager exposes an update check. */
  latest?: string;
  /** Semver gap tier; absent when either version is unknown. */
  tier?: SemverTier;
  /** Exact command text that applies the update. */
  applyCommand?: string;
  /** Exact command text that pins the installed version. */
  pinCommand?: string;
  skew?: PathSkew;
  /** The tool's own update announcement, matched by the configured pattern. */
  announcement?: string;
  /** Probe failure detail; reported verbatim in the sparse errors block. */
  error?: string;
}

/**
 * Apply/pin request. The apply task finalizes the execution contract
 * (plan by default, `--execute` to act, journaling); this build refuses.
 */
export interface MutationRequest {
  /** Named tools within the surface; all when absent. */
  tools?: string[];
  /** False (default) prints the plan; true executes. */
  execute: boolean;
}

/** Placeholder outcome; superseded by the apply task. */
export interface MutationOutcome {
  planned: string[];
}

/**
 * The surface module contract: one module per ecosystem.
 *
 * `detect` answers whether the surface's manager is installed. `status` is
 * read-only and always safe. `apply` delegates to the vendor's own updater
 * with fixed argv; `pin` delegates to the vendor's own pin command. This
 * build implements `detect` and `status`; `apply` and `pin` refuse.
 */
export interface Surface {
  readonly id: string;
  readonly description: string;
  /** Name of the surface's manager executable (the row reported when absent). */
  readonly managerTool: string;
  detect(ctx: SurfaceContext): Promise<boolean>;
  status(ctx: SurfaceContext): Promise<ToolStatus[]>;
  apply(
    ctx: SurfaceContext,
    request: MutationRequest,
  ): Promise<MutationOutcome>;
  pin(ctx: SurfaceContext, request: MutationRequest): Promise<MutationOutcome>;
}
