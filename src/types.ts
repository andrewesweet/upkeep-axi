/**
 * Core data model: configuration, status rows, and the surface module contract.
 *
 * Every configured surface is one module exposing `detect`, `status`, `apply`,
 * and `replacedExecutables`. `detect` and `status` are read-only; `apply`
 * declares the fixed delegate argv that the apply runner executes.
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
 * - `git`: watched-tools schema compatibility only. The Firstmate-fork
 *   surface describes its one subject with the surface-level `clonePath`,
 *   not per-tool entries.
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
  /** Per-tool entries merged over the surface's discovered tools. */
  tools?: ToolConfig[];
  /** apt only: where the reboot-required flag lives (default /var/run/reboot-required). */
  rebootRequiredPath?: string;
  /** snap only: the snapd REST API socket (default /run/snapd.socket). */
  socketPath?: string;
  /** firstmate only: the local clone of the fork (default /home/andre/tools/firstmate). */
  clonePath?: string;
  /**
   * apply only: the budget for one delegate run in milliseconds. A delegate
   * still running at the budget is left running and reported unconfirmed.
   * Defaults to DEFAULT_APPLY_TIMEOUT_MS (900000).
   */
  applyTimeoutMs?: number;
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

/** Where an in-use fact came from: the three sources the captain named. */
export type InUseSource = "herdr" | "no-mistakes" | "process";

/** Measured PATH skew: a newer copy of `command` sits behind the resolved one. */
export interface PathSkew {
  command: string;
  resolvedPath: string;
  resolvedVersion?: string;
  newerPath: string;
  newerVersion?: string;
}

/**
 * One step of a delegate: an absolute executable and its fixed argv. argv is
 * declared in the surface module and never assembled anywhere else.
 */
export interface ApplyStep {
  file: string;
  args: string[];
}

/**
 * The fixed delegate one apply runs: the vendor's own updater, spelled as an
 * ordered list of steps (usually one) that run sequentially, `&&` semantics:
 * the first failing or over-budget step stops the delegate.
 */
export interface ApplyDelegate {
  steps: ApplyStep[];
}

/**
 * Firstmate-fork sync facts, measured by a trial rebase of the fork's
 * bespoke commits onto upstream main in a scratch worktree.
 */
export interface ForkSync {
  /**
   * - `current`: nothing to sync (the fork equals upstream, or the fork is
   *   ahead and upstream has nothing new).
   * - `fast-forward`: nothing bespoke; upstream main simply moved ahead.
   * - `clean-rebase`: the bespoke commits replay onto upstream main cleanly.
   * - `conflicts`: the trial rebase stopped; `files` lists the conflicts.
   */
  class: "fast-forward" | "clean-rebase" | "conflicts" | "current";
  /** Fork commits ahead of upstream main (the bespoke commits). */
  forkAhead: number;
  /** Upstream main commits ahead of the fork. */
  upstreamAhead: number;
  /** The fork's GitHub owner/name, when the fork remote URL is one. */
  forkRepo?: string;
  /** Conflicting files, present only when class is conflicts. */
  files?: string[];
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
  /**
   * Measured only for installed rows whose apply exists: true when a source
   * (herdr agent list, no-mistakes runs, the process table) names an
   * executable the apply would replace; false when the sources measured
   * clear or the module declares replacement safe while running. Absent
   * where there is nothing to apply. Sources that fail contribute nothing.
   */
  inUse?: boolean;
  /** Why the row is in use; reported verbatim in the sparse in_use block. */
  inUseDetail?: string;
  /**
   * The executables this row's package installs (npm `bin` names), for
   * in-use measurement when the package name is not the executable name.
   */
  executables?: string[];
  /**
   * Why apply must skip this row, when the surface knows a reason no
   * delegate exists (firstmate: the trial rebase conflicted, with the
   * files). Not rendered on the row; the plan's skipped block reports it.
   */
  refusal?: string;
  /** Firstmate fork sync facts, when this row is the fork sync row. */
  sync?: ForkSync;
}

/**
 * The surface module contract: one module per ecosystem.
 *
 * `detect` answers whether the surface's manager is installed. `status` is
 * read-only and always safe. `apply` declares the fixed delegate argv for one
 * of its own status rows - the vendor's own updater, never assembled at
 * runtime anywhere else; undefined where the surface cannot apply the tool
 * (report-only, pinned, no vendor updater). `replacedExecutables` names the
 * executables whose files an apply of the row would replace; the default is
 * the tool name itself, and an empty list means the row installs no
 * executable. Rollback is not a
 * module concern: every row carries its pin command text, and the journal
 * records it.
 *
 * Deliberate shape change in the apply build: the prior `pin` method (a
 * refusal stub) is gone; pin text stays where it already lived, on the row.
 */
export interface Surface {
  readonly id: string;
  readonly description: string;
  /** Name of the surface's manager executable (the row reported when absent). */
  readonly managerTool: string;
  /**
   * Report-only surface metadata: the rows carry the exact command the
   * caller runs by hand, but no delegate ever runs here. Naming the surface
   * for apply is a usage error that quotes `manualCommand` verbatim, `--all`
   * never plans it (the module's `apply` returns undefined), and scoped
   * status hints quote the rows' own commands instead of apply.
   */
  readonly reportOnly?: { manualCommand: string };
  detect(ctx: SurfaceContext): Promise<boolean>;
  status(ctx: SurfaceContext): Promise<ToolStatus[]>;
  apply(ctx: SurfaceContext, row: ToolStatus): ApplyDelegate | undefined;
  replacedExecutables?(row: ToolStatus): string[];
}
