import { tierBetween } from "../semver.js";
import { mapLimit, pathCandidates } from "../exec.js";
import type { Surface, SurfaceContext, ToolStatus } from "../types.js";
import {
  deferredMutation,
  enrichWithConfig,
  managerErrorRow,
  managerVersion,
} from "./shared.js";

const SURFACE_ID = "cargo";
const LIST_TIMEOUT_MS = 15_000;
const SEARCH_TIMEOUT_MS = 30_000;
const PROBE_CONCURRENCY = 8;

function managerPath(ctx: SurfaceContext): string | undefined {
  return pathCandidates("cargo", ctx.env)[0];
}

export interface CargoInstall {
  name: string;
  version: string;
}

/**
 * Parse `cargo install --list`: top-level rows `name vX.Y.Z[ (source)]:`, with
 * the installed binaries indented underneath. Only rows that start with a
 * non-whitespace character are crates; the leading `v` of the version is
 * stripped so pin commands can pass it to `cargo install --version` verbatim.
 */
export function parseCargoInstallList(stdout: string): CargoInstall[] {
  const installs: CargoInstall[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^(\S+) v([^\s(:]+)/);
    if (match) installs.push({ name: match[1], version: match[2] });
  }
  return installs;
}

/**
 * Latest version from `cargo search <crate> --limit 1`: the row whose first
 * column is exactly the crate, spelled `crate = "X.Y.Z"    # description`.
 * A search that answers without the exact crate yields nothing.
 */
export function parseCargoSearch(
  stdout: string,
  crate: string,
): string | undefined {
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(`${crate} = "`)) continue;
    const match = line.match(/= "([^"]+)"/);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * cargo-installed binaries. Installed crates and versions come from
 * `cargo install --list`; the available version of each crate comes from
 * `cargo search <crate> --limit 1`, the crates.io index check the cargo CLI
 * exposes. A crate whose search fails or does not name it keeps its latest
 * and tier absent. Re-running `cargo install <crate>` is how cargo upgrades
 * an installed crate, so that is the apply command.
 */
export const cargoSurface: Surface = {
  id: SURFACE_ID,
  description: "cargo-installed binaries",
  managerTool: "cargo",

  async detect(ctx) {
    return managerPath(ctx) !== undefined;
  },

  async status(ctx) {
    const cargo = managerPath(ctx);
    if (!cargo) return [];
    const ls = await ctx.exec(cargo, ["install", "--list"], LIST_TIMEOUT_MS);
    const installed = parseCargoInstallList(ls.stdout);
    if (ls.code !== 0 && installed.length === 0) {
      const version = await managerVersion(ctx, cargo);
      return enrichWithConfig(ctx, SURFACE_ID, [
        managerErrorRow(
          SURFACE_ID,
          "cargo",
          version,
          `cargo install --list failed (exit ${ls.code}${ls.timedOut ? ", timed out" : ""})`,
        ),
      ]);
    }
    const rows: ToolStatus[] = await mapLimit(
      installed,
      PROBE_CONCURRENCY,
      async (install) => {
        const search = await ctx.exec(
          cargo,
          ["search", install.name, "--limit", "1"],
          SEARCH_TIMEOUT_MS,
        );
        const latest =
          search.code === 0 && !search.timedOut
            ? parseCargoSearch(search.stdout, install.name)
            : undefined;
        return {
          surface: SURFACE_ID,
          tool: install.name,
          installed: true,
          version: install.version,
          latest,
          tier: tierBetween(install.version, latest),
          applyCommand: `cargo install ${install.name}`,
          pinCommand: `cargo install ${install.name} --version ${install.version}`,
        };
      },
    );
    return enrichWithConfig(ctx, SURFACE_ID, rows);
  },

  async apply() {
    deferredMutation(SURFACE_ID, "apply");
  },

  async pin() {
    deferredMutation(SURFACE_ID, "pin");
  },
};
