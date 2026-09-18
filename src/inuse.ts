import { readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { mapLimit, pathCandidates, runBounded } from "./exec.js";
import type { InUseSource, Surface, ToolStatus } from "./types.js";

export interface InUseFact {
  source: InUseSource;
  detail: string;
}

/**
 * herdr agent statuses that mean the agent binary is idle. Anything else
 * (working, waiting, and statuses herdr adds later) counts as in use:
 * uncertainty reads as in use, never as free.
 */
const INACTIVE_HERDR_STATUSES = new Set(["done", "stopped", "exited", "dead"]);

/**
 * no-mistakes run statuses that mean the pipeline is driving agents right
 * now. These are the statuses its own advice calls active.
 */
const ACTIVE_NO_MISTAKES_RUN_STATUSES = new Set(["running", "fixing"]);

/**
 * The agent executables an active no-mistakes run may be driving (its
 * configured agent list), plus no-mistakes itself: updating any of them
 * while a run is active would pull the binary out from under the pipeline.
 */
const NO_MISTAKES_DRIVEN = [
  "no-mistakes",
  "claude",
  "codex",
  "opencode",
  "pi",
  "acpx",
  "cursor-agent",
  "copilot",
  "grok",
  "rovodev",
  "antigravity",
];

interface HerdrAgentList {
  result?: { agents?: Array<{ agent?: unknown; agent_status?: unknown }> };
}

/**
 * In-use facts, read from the three sources the captain named - herdr's
 * agent list, no-mistakes' active runs, and the process table - and never
 * from Firstmate's files. Each source is probed at most once per run and
 * cached; a source that is missing or fails contributes nothing (its
 * absence never reads as a positive claim).
 */
export class InUseProber {
  private herdrAgents?: Promise<string[]>;
  private noMistakesRuns?: Promise<Array<{ branch: string; status: string }>>;
  private processes?: Promise<Map<string, Array<{ pid: number; exe: string }>>>;

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  /**
   * Facts for the files one apply would replace: the executables named, and
   * the executable-root prefixes declared (a bundle whose processes run
   * under a directory, e.g. /snap/<name>/<revision>/...). The process table
   * matches only processes whose /proc/<pid>/exe resolves to a copy of the
   * watched name on this run's PATH - the same copies the apply would swap -
   * or whose real executable path lies under a declared prefix. One process
   * matched both ways is one fact. The sources are probed sequentially and
   * the table is read last, so our own probe processes are gone by the time
   * it is scanned. Each probe is cached as its promise, so concurrent
   * callers share one in-flight probe and none reads a placeholder before
   * the probe answers.
   */
  async factsFor(
    executables: string[],
    executableRoots: string[] = [],
  ): Promise<InUseFact[]> {
    if (executables.length === 0 && executableRoots.length === 0) return [];
    const wanted = new Set(executables);
    const herdr = await (this.herdrAgents ??= this.probeHerdrAgents());
    const runs = await (this.noMistakesRuns ??= this.probeNoMistakesRuns());
    const processes = await (this.processes ??= this.probeProcessTable());
    const facts: InUseFact[] = [];
    for (const agent of herdr) {
      if (wanted.has(agent)) {
        facts.push({
          source: "herdr",
          detail: `herdr agent ${agent} is active`,
        });
      }
    }
    for (const run of runs) {
      const driven = NO_MISTAKES_DRIVEN.filter((name) => wanted.has(name));
      for (const name of driven) {
        facts.push({
          source: "no-mistakes",
          detail: `no-mistakes run ${run.branch} is ${run.status} (drives ${name})`,
        });
      }
    }
    const seen = new Set<number>();
    for (const name of executables) {
      for (const candidate of pathCandidates(name, this.env)) {
        for (const process of processes.get(realpath(candidate)) ?? []) {
          if (seen.has(process.pid)) continue;
          seen.add(process.pid);
          facts.push({
            source: "process",
            detail: `process ${process.pid} runs ${process.exe}`,
          });
        }
      }
    }
    const roots = executableRoots
      .map(executableRootPrefix)
      .filter((root) => root !== undefined);
    for (const list of processes.values()) {
      for (const process of list) {
        if (seen.has(process.pid)) continue;
        if (!roots.some((root) => process.exe.startsWith(root))) continue;
        seen.add(process.pid);
        facts.push({
          source: "process",
          detail: `process ${process.pid} runs ${process.exe}`,
        });
      }
    }
    return facts;
  }

  /** Active herdr agents as [name, status] pairs; [] when herdr is absent. */
  private async probeHerdrAgents(): Promise<string[]> {
    const herdr = pathCandidates("herdr", this.env)[0];
    if (!herdr) return [];
    const result = await runBounded(herdr, ["agent", "list"], this.env);
    try {
      const parsed = JSON.parse(result.stdout) as HerdrAgentList;
      const agents = parsed.result?.agents;
      if (Array.isArray(agents)) {
        return agents
          .filter(
            (agent): agent is { agent: string; agent_status: string } =>
              typeof agent?.agent === "string" &&
              typeof agent?.agent_status === "string" &&
              !INACTIVE_HERDR_STATUSES.has(agent.agent_status),
          )
          .map((agent) => agent.agent);
      }
    } catch {
      // Unparseable output: the source contributes nothing.
    }
    return [];
  }

  /** Active no-mistakes runs; [] when no-mistakes is absent or quiescent. */
  private async probeNoMistakesRuns(): Promise<
    Array<{ branch: string; status: string }>
  > {
    const nomistakes = pathCandidates("no-mistakes", this.env)[0];
    if (!nomistakes) return [];
    const result = await runBounded(nomistakes, ["runs"], this.env);
    if (result.code !== 0 || result.timedOut) return [];
    const runs: Array<{ branch: string; status: string }> = [];
    for (const line of result.stdout.split("\n")) {
      // Row shape: `  <status>    <branch> <sha>  <date>  [<url>]`.
      const match = line.match(/^\s+(\S+)\s+(\S+)\s+[0-9a-f]{7,40}\b/);
      if (!match) continue;
      if (ACTIVE_NO_MISTAKES_RUN_STATUSES.has(match[1])) {
        runs.push({ status: match[1], branch: match[2] });
      }
    }
    return runs;
  }

  /**
   * The process table as executable-path -> processes, excluding this run's
   * own process tree: an inventory run must never report itself in use.
   * Processes whose exe does not resolve (another user, a kernel thread) are
   * not attributed - nothing is claimed about them.
   */
  private async probeProcessTable(): Promise<
    Map<string, Array<{ pid: number; exe: string }>>
  > {
    const processes = new Map<string, Array<{ pid: number; exe: string }>>();
    const own = ancestorPids();
    let entries: string[];
    try {
      entries = readdirSync("/proc");
    } catch {
      return processes;
    }
    for (const entry of entries) {
      const pid = Number.parseInt(entry, 10);
      if (!Number.isInteger(pid) || own.has(pid)) continue;
      let exe: string;
      try {
        // readlink, never read: /proc/<pid>/exe is a symlink to the binary,
        // and reading it would pull every running image into memory.
        exe = readlinkSync(`/proc/${entry}/exe`);
      } catch {
        continue;
      }
      const list = processes.get(exe) ?? [];
      list.push({ pid, exe });
      processes.set(exe, list);
    }
    return processes;
  }
}

/**
 * A declared executable root as a directory prefix. /proc/<pid>/exe paths
 * end in the binary's name, so the root must end in the separator to mean
 * "under this directory" and not "a sibling directory named alike"
 * (/snap/fire/ must not match /snap/firefox/...). Empty roots are dropped:
 * an empty prefix would match every process on the host.
 */
function executableRootPrefix(root: string): string | undefined {
  const trimmed = root.trim();
  if (!trimmed) return undefined;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/**
 * /proc/<pid>/exe is the resolved binary, so a PATH entry that is a symlink
 * or shim (fnm multishell links, installer stubs) must be resolved to match.
 */
function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** This process and every ancestor up to init, so they can be excluded. */
function ancestorPids(): Set<number> {
  const pids = new Set<number>([process.pid]);
  let pid = process.pid;
  for (let depth = 0; depth < 64; depth++) {
    let status: string;
    try {
      status = readFileSync(`/proc/${pid}/status`, "utf-8");
    } catch {
      break;
    }
    const ppid = status.match(/^PPid:\s+(\d+)\s*$/m);
    if (!ppid) break;
    const parent = Number.parseInt(ppid[1], 10);
    if (!Number.isInteger(parent) || parent <= 1) break;
    pids.add(parent);
    pid = parent;
  }
  return pids;
}

/**
 * The executables one apply would replace, for in-use measurement. The
 * default is the tool itself; a surface whose package names differ from
 * their executables (npm globals) overrides with the row's bin names, and
 * a surface whose rows share one manager binary overrides with that binary.
 */
export function replacedExecutablesFor(
  surface: Pick<Surface, "replacedExecutables">,
  row: ToolStatus,
): string[] {
  if (surface.replacedExecutables) return surface.replacedExecutables(row);
  return [row.tool];
}

/**
 * Mark every installed row that has an apply with measured in-use facts.
 * Rows without an apply keep in_use absent - there is nothing to protect.
 * Failures in a source contribute nothing, and a row whose sources measured
 * clear reads in_use=false.
 */
export async function markInUse(
  surface: Pick<Surface, "replacedExecutables">,
  rows: ToolStatus[],
  prober: InUseProber,
): Promise<void> {
  await mapLimit(rows, 8, async (row) => {
    if (!row.installed || !row.applyCommand) return;
    const facts = await prober.factsFor(
      replacedExecutablesFor(surface, row),
      row.executableRoots ?? [],
    );
    row.inUse = facts.length > 0;
    if (facts.length > 0) {
      row.inUseDetail = facts.map((fact) => fact.detail).join("; ");
    }
  });
}
