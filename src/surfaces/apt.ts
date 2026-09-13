import { existsSync } from "node:fs";
import { tierBetween } from "../semver.js";
import { pathCandidates } from "../exec.js";
import type {
  SemverTier,
  Surface,
  SurfaceContext,
  ToolStatus,
} from "../types.js";
import { enrichWithConfig, managerErrorRow, managerVersion } from "./shared.js";

const SURFACE_ID = "apt";
const LIST_TIMEOUT_MS = 30_000;
const DEFAULT_REBOOT_REQUIRED_PATH = "/var/run/reboot-required";

function managerPath(ctx: SurfaceContext): string | undefined {
  return pathCandidates("apt", ctx.env)[0];
}

export interface AptUpgradable {
  name: string;
  latest?: string;
  from?: string;
}

/**
 * Parse `apt list --upgradable`: rows spelled
 * `name/suite candidate arch [upgradable from: current]`. The `Listing...`
 * banner and anything else that does not match the row shape is skipped.
 */
export function parseAptUpgradable(stdout: string): AptUpgradable[] {
  const packages: AptUpgradable[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(
      /^([^/\s]+)\/\S*\s+(\S+)\s+\S+(?:\s+\[upgradable from: ([^\]]+)\])?\s*$/,
    );
    if (!match) continue;
    packages.push({ name: match[1], latest: match[2], from: match[3] });
  }
  return packages;
}

function splitEpoch(version: string): [number, string] {
  const match = version.match(/^(\d+):(.*)$/);
  return match ? [Number(match[1]), match[2]] : [0, version];
}

/**
 * Debian versions carry an optional `epoch:` prefix that outranks the rest;
 * the semver heuristic cannot see it (`1:` has no dot), so an epoch bump is
 * tiered here as major and only equal epochs fall through to the numeric
 * prefix comparison.
 */
export function debianTier(
  from: string | undefined,
  latest: string | undefined,
): SemverTier | undefined {
  if (from === undefined || latest === undefined) return undefined;
  const [fromEpoch, fromRest] = splitEpoch(from);
  const [latestEpoch, latestRest] = splitEpoch(latest);
  if (fromEpoch !== latestEpoch) return "major";
  return tierBetween(fromRest, latestRest);
}

function rebootRequiredRow(ctx: SurfaceContext): ToolStatus {
  const path = ctx.surface.rebootRequiredPath ?? DEFAULT_REBOOT_REQUIRED_PATH;
  return {
    surface: SURFACE_ID,
    tool: "reboot-required",
    installed: existsSync(path),
  };
}

/**
 * apt, report-only: the tool never runs apt with root and never applies
 * anything here. Upgradable packages come from `apt list --upgradable`;
 * each row carries the candidate version, the installed one when apt names
 * it, and the exact `sudo apt-get` commands that close the gap - commands
 * the captain runs, never this tool. The reboot-required flag is reported
 * as a row whose presence is the fact; its path is a config option
 * (`rebootRequiredPath`, default /var/run/reboot-required). Debian version
 * strings tier by epoch, then numeric prefix, so a revision-only bump can
 * tier as none even though the row still carries both versions verbatim.
 */
export const aptSurface: Surface = {
  id: SURFACE_ID,
  description: "apt packages (report-only)",
  managerTool: "apt",

  async detect(ctx) {
    return managerPath(ctx) !== undefined;
  },

  async status(ctx) {
    const apt = managerPath(ctx);
    if (!apt) return [];
    const list = await ctx.exec(apt, ["list", "--upgradable"], LIST_TIMEOUT_MS);
    const upgradable = parseAptUpgradable(list.stdout);
    const rows: ToolStatus[] = [];
    if (list.code !== 0 && upgradable.length === 0) {
      const version = await managerVersion(ctx, apt);
      rows.push(
        managerErrorRow(
          SURFACE_ID,
          "apt",
          version,
          `apt list --upgradable failed (exit ${list.code}${list.timedOut ? ", timed out" : ""})`,
        ),
      );
    } else {
      rows.push(
        ...upgradable.map((pkg) => ({
          surface: SURFACE_ID,
          tool: pkg.name,
          installed: true,
          version: pkg.from,
          latest: pkg.latest,
          tier: debianTier(pkg.from, pkg.latest),
          applyCommand: "sudo apt-get update && sudo apt-get upgrade",
          pinCommand: pkg.from
            ? `sudo apt-get install ${pkg.name}=${pkg.from}`
            : undefined,
        })),
      );
    }
    rows.push(rebootRequiredRow(ctx));
    return enrichWithConfig(ctx, SURFACE_ID, rows);
  },

  /** Report-only: apt has no delegate here, ever. Nothing runs as root. */
  apply() {
    return undefined;
  },
};
