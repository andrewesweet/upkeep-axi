import {
  snapdRefreshCandidates,
  snapdSnaps,
  snapdSocketPath,
  snapdSystemInfo,
} from "../snapd.js";
import { compareVersions, parseVersion, tierBetween } from "../semver.js";
import type { SemverTier, Surface, SnapState, ToolStatus } from "../types.js";
import {
  configuredEntries,
  enrichWithConfig,
  managerErrorRow,
} from "./shared.js";

const SURFACE_ID = "snap";
const DEFAULT_SNAP_MOUNT_DIR = "/snap";

/** The exact manual command for one snap: the only apply text a row carries. */
function manualCommand(name: string): string {
  return `sudo snap refresh ${name}`;
}

/** One app entry of an installed snap (the fields this surface reads). */
interface SnapApp {
  name?: unknown;
  daemon?: unknown;
}

/** One installed snap from /v2/snaps (the fields this surface reads). */
interface SnapSnap {
  name?: unknown;
  status?: unknown;
  type?: unknown;
  version?: unknown;
  revision?: unknown;
  "tracking-channel"?: unknown;
  apps?: unknown;
  hold?: unknown;
  "gating-hold"?: unknown;
  "refresh-inhibit"?: unknown;
}

/** One refresh candidate from /v2/find?select=refresh. */
interface SnapCandidate {
  name?: unknown;
  version?: unknown;
  revision?: unknown;
}

/** The fields of /v2/system-info this surface reads. */
interface SnapSystemInfo {
  version?: unknown;
  "snap-mount-dir"?: unknown;
}

/**
 * Tier of a snap gap, revision-aware.
 *
 * Vendor versions are not semver (`0+git.b31ceab-sdk0+git.f0723a0`), and a
 * snap can refresh with an unchanged version string but a new revision.
 * When both versions parse and the offered one is forward, severity is the
 * ordinary semver tier. Otherwise a differing revision is the only proof a
 * real update exists - and revision numbers carry no severity, so the
 * conservative known-gap tier is `major`. With no offered version and no
 * differing revision there is no proved gap and the tier stays absent; the
 * revision number itself is never read as patch/minor/major.
 */
export function snapTier(
  installedVersion: string | undefined,
  installedRevision: string | undefined,
  offeredVersion: string | undefined,
  offeredRevision: string | undefined,
): SemverTier | undefined {
  if (offeredVersion === undefined && offeredRevision === undefined) {
    return undefined;
  }
  const installed =
    installedVersion === undefined ? undefined : parseVersion(installedVersion);
  const offered =
    offeredVersion === undefined ? undefined : parseVersion(offeredVersion);
  if (installed && offered && compareVersions(offered, installed) > 0) {
    return tierBetween(installedVersion, offeredVersion);
  }
  if (
    installedRevision !== undefined &&
    offeredRevision !== undefined &&
    offeredRevision !== installedRevision
  ) {
    return "major";
  }
  return undefined;
}

function asObject(result: unknown): SnapSystemInfo {
  return result !== null && typeof result === "object" && !Array.isArray(result)
    ? (result as SnapSystemInfo)
    : {};
}

/** The snap array behind a snaps/find result, or undefined when malformed. */
function asSnapArray(result: unknown): SnapSnap[] | undefined {
  if (!Array.isArray(result)) return undefined;
  return result.filter(
    (snap): snap is SnapSnap =>
      snap !== null && typeof snap === "object" && !Array.isArray(snap),
  );
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function appsOf(snap: SnapSnap): SnapApp[] {
  if (!Array.isArray(snap.apps)) return [];
  return snap.apps.filter(
    (app): app is SnapApp =>
      app !== null && typeof app === "object" && !Array.isArray(app),
  );
}

/**
 * A user-launchable app: one with a name that is not a daemon service.
 * App-typed content providers carry either no apps at all or daemon-only
 * entries, so launchability - not a "content" type, which snapd does not
 * expose - is the inventory filter.
 */
function isLaunchable(app: SnapApp): boolean {
  return !app.daemon && str(app.name) !== undefined;
}

function launchableNames(snap: SnapSnap): string[] {
  return appsOf(snap)
    .filter(isLaunchable)
    .map((app) => app.name as string);
}

/**
 * Whether a snap becomes a row. A configured name overrides the filter: the
 * user asked for that snap, so a daemon-only or non-app snap is inventoried
 * rather than misreported as unknown to the manager. A non-active status is
 * never inventoried (/v2/snaps lists active snaps only; this is defensive).
 */
function includeSnap(snap: SnapSnap, configured: Set<string>): boolean {
  const name = str(snap.name);
  if (name === undefined) return false;
  if (typeof snap.status === "string" && snap.status !== "active") return false;
  if (configured.has(name)) return true;
  if (snap.type !== "app") return false;
  return appsOf(snap).some(isLaunchable);
}

/** The snap mount dir from system-info, defaulting to /snap. */
function mountDirFrom(systemInfo: SnapSystemInfo): string {
  const dir = str(systemInfo["snap-mount-dir"]);
  if (dir === undefined) return DEFAULT_SNAP_MOUNT_DIR;
  const trimmed = dir.replace(/\/+$/, "");
  return trimmed || DEFAULT_SNAP_MOUNT_DIR;
}

function buildRow(
  snap: SnapSnap,
  candidatesByName: Map<string, SnapCandidate>,
  mountDir: string,
): ToolStatus {
  const name = snap.name as string;
  const version = str(snap.version);
  const revision = str(snap.revision);
  const row: ToolStatus = {
    surface: SURFACE_ID,
    tool: name,
    installed: true,
    version,
    applyCommand: manualCommand(name),
  };
  const state: SnapState = {};
  if (revision !== undefined) state.revision = revision;
  const channel = str(snap["tracking-channel"]);
  if (channel !== undefined) state.channel = channel;
  const candidate = candidatesByName.get(name);
  if (candidate) {
    const offeredVersion = str(candidate.version);
    const offeredRevision = str(candidate.revision);
    if (offeredVersion !== undefined) row.latest = offeredVersion;
    row.tier = snapTier(version, revision, offeredVersion, offeredRevision);
    if (offeredRevision !== undefined)
      state.availableRevision = offeredRevision;
  }
  const hold = snap.hold;
  if (hold !== undefined && hold !== null) state.hold = hold;
  const gatingHold = snap["gating-hold"];
  if (gatingHold !== undefined && gatingHold !== null) {
    state.gatingHold = gatingHold;
  }
  const refreshInhibit = snap["refresh-inhibit"];
  if (refreshInhibit !== undefined && refreshInhibit !== null) {
    state.refreshInhibit = refreshInhibit;
  }
  if (Object.keys(state).length > 0) row.snapState = state;
  const executables = launchableNames(snap);
  if (executables.length > 0) row.executables = executables;
  // A snap app runs under <mount-dir>/<name>/<revision>/..., never at the
  // launcher symlink on PATH, so in-use matching matches this prefix.
  row.executableRoots = [`${mountDir}/${name}`];
  return row;
}

/**
 * Snap packages, report-only: the tool never runs snap, even with sudo.
 * Inventory comes from snapd's REST API over its Unix socket (the bounded
 * GET client in src/snapd.ts, never the `snap` CLI): active installed snaps
 * from /v2/snaps, and the refresh candidates snapd offers this host from
 * /v2/find?select=refresh - never the store-wide channel map, so a release
 * a phase, validation set, or hold has not offered this host reports no
 * gap. Rows are user-launchable app snaps (a configured name overrides the
 * filter); each carries the tracked channel, revisions, and hold facts
 * internally, the exact `sudo snap refresh <name>` command, and no pin. An
 * absent socket is normal absence; a read failure after detection is one
 * probe error carrying the client's reason verbatim, never fabricated
 * inventory.
 */
export const snapSurface: Surface = {
  id: SURFACE_ID,
  description: "Snap packages (report-only)",
  managerTool: "snap",
  reportOnly: { manualCommand: "sudo snap refresh <name>" },

  async detect(ctx) {
    // Absence (no socket file, no listener) is the only not-detected signal.
    // An error read means something answered the socket or host policy
    // protects it: detect hands to status, which reports the failure
    // verbatim, rather than losing it as absence.
    const read = await snapdSystemInfo(snapdSocketPath(ctx.surface));
    return read.kind !== "absent";
  },

  async status(ctx) {
    const socket = snapdSocketPath(ctx.surface);
    const info = await snapdSystemInfo(socket);
    if (info.kind !== "ok") {
      return enrichWithConfig(ctx, SURFACE_ID, [
        managerErrorRow(SURFACE_ID, SURFACE_ID, undefined, info.reason),
      ]);
    }
    const systemInfo = asObject(info.result);
    const version = str(systemInfo.version);
    const snaps = await snapdSnaps(socket);
    if (snaps.kind !== "ok") {
      return enrichWithConfig(ctx, SURFACE_ID, [
        managerErrorRow(SURFACE_ID, SURFACE_ID, version, snaps.reason),
      ]);
    }
    const installed = asSnapArray(snaps.result);
    if (!installed) {
      return enrichWithConfig(ctx, SURFACE_ID, [
        managerErrorRow(
          SURFACE_ID,
          SURFACE_ID,
          version,
          "GET /v2/snaps returned a result that is not a snap array",
        ),
      ]);
    }
    const candidates = await snapdRefreshCandidates(socket);
    // A failed refresh read is a probe error, but the inventory read
    // succeeded: keep the installed rows, whose latest and tier stay
    // absent because snapd offered this host no candidate.
    let candidatesByName = new Map<string, SnapCandidate>();
    let candidateError: string | undefined;
    if (candidates.kind === "ok") {
      const offered = asSnapArray(candidates.result);
      if (offered) {
        candidatesByName = new Map(
          offered
            .map((candidate) => [str(candidate.name), candidate] as const)
            .filter(
              (pair): pair is [string, SnapCandidate] => pair[0] !== undefined,
            ),
        );
      } else {
        candidateError =
          "GET /v2/find?select=refresh returned a result that is not a snap array";
      }
    } else {
      candidateError = candidates.reason;
    }
    const rows: ToolStatus[] = [];
    if (candidateError !== undefined) {
      rows.push(
        managerErrorRow(SURFACE_ID, SURFACE_ID, version, candidateError),
      );
    }
    const configured = new Set(
      configuredEntries(ctx).map((entry) => entry.name),
    );
    const mountDir = mountDirFrom(systemInfo);
    for (const snap of installed) {
      if (includeSnap(snap, configured)) {
        rows.push(buildRow(snap, candidatesByName, mountDir));
      }
    }
    return enrichWithConfig(ctx, SURFACE_ID, rows);
  },

  /** Report-only: snap has no delegate here, ever. Nothing runs as root. */
  apply() {
    return undefined;
  },

  /** A refresh replaces the app images the snap's non-daemon apps name. */
  replacedExecutables: (row) => row.executables ?? [],
};
