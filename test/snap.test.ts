import { describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  createEnv,
  installStandardFakes,
  runCli,
  startSnapdFixture,
  type FakeEnv,
  type SnapdFixture,
  type SnapdFixtureResponse,
} from "./helpers.js";
import { snapSurface, snapTier } from "../src/surfaces/snap.js";
import type { SurfaceContext, ToolStatus } from "../src/types.js";

function stdEnv(): FakeEnv {
  const env = createEnv();
  installStandardFakes(env);
  return env;
}

/** Run one fixture-backed scenario with guaranteed teardown. */
async function withFixture(
  fake: FakeEnv,
  scenario: (fixture: SnapdFixture) => Promise<void>,
): Promise<void> {
  const fixture = await startSnapdFixture(fake.root);
  try {
    await scenario(fixture);
  } finally {
    await fixture.close();
  }
}

/**
 * Pin the spawned CLI's snap surface at the fixture socket (the fake env's
 * default pin is an absent path), optionally with extra snap surface config.
 */
function pinSnapSurface(
  fake: FakeEnv,
  fixture: SnapdFixture,
  extra: Record<string, unknown> = {},
): void {
  fake.writeConfig({
    surfaces: { snap: { socketPath: fixture.socketPath, ...extra } },
  });
}

/** A bounded context for calling the surface module directly. */
function surfaceCtx(socketPath: string): SurfaceContext {
  return {
    config: { surfaces: { snap: { socketPath } } },
    surface: { socketPath },
    env: { PATH: "/nonexistent" },
    exec: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
  };
}

/** Queue responses, call the surface's status directly, return its rows. */
async function directStatus(
  fixture: SnapdFixture,
  ...responses: SnapdFixtureResponse[]
): Promise<ToolStatus[]> {
  fixture.queue(...responses);
  return snapSurface.status(surfaceCtx(fixture.socketPath));
}

const SYSTEM_INFO = { version: "2.76.3", series: "16" };

/**
 * Queue the standard read sequence an end-to-end run makes. detect reads
 * system-info first, then status reads it again for the manager version and
 * mount dir, then the inventory and refresh reads.
 */
function queueReads(
  fixture: SnapdFixture,
  snaps: unknown,
  candidates: unknown,
): void {
  fixture.queue(
    { ok: SYSTEM_INFO },
    { ok: SYSTEM_INFO },
    { ok: snaps },
    { ok: candidates },
  );
}

/** The motivating snap: an app with two launchable commands. */
function firefoxSnap(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "firefox",
    status: "active",
    type: "app",
    version: "154.0.1-1",
    revision: "8803",
    "tracking-channel": "latest/stable",
    apps: [{ name: "firefox" }, { name: "geckodriver" }],
    ...overrides,
  };
}

/** The store's candidate for firefox on its tracked channel. */
const FIREFOX_CANDIDATE = {
  name: "firefox",
  version: "156.0-1",
  revision: "8929",
  "tracking-channel": "latest/stable",
};

describe("snap surface (report-only)", () => {
  it("reports the motivating gap: one app row, tier major, the manual command", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      pinSnapSurface(fake, fixture);
      queueReads(
        fixture,
        [
          {
            name: "bare",
            status: "active",
            type: "base",
            version: "1.0",
            revision: "5",
            "tracking-channel": "latest/stable",
          },
          {
            name: "core24",
            status: "active",
            type: "base",
            version: "20260824",
            revision: "2124",
            "tracking-channel": "latest/stable",
          },
          {
            name: "gnome-46-2404",
            status: "active",
            type: "app",
            version: "0+git.b31ceab-sdk0+git.f0723a0",
            revision: "164",
            "tracking-channel": "latest/stable",
          },
          {
            name: "mesa-2404",
            status: "active",
            type: "app",
            version: "25.2.8-snap288",
            revision: "1839",
            "tracking-channel": "latest/stable",
            apps: [{ name: "component-monitor", daemon: "simple" }],
          },
          {
            name: "snapd",
            status: "active",
            type: "snapd",
            version: "2.76.3",
            revision: "27738",
            "tracking-channel": "latest/stable",
          },
          firefoxSnap(),
        ],
        [FIREFOX_CANDIDATE],
      );
      const result = await runCli(["status", "--surface", "snap"], fake.env());
      expect(result.code).toBe(0);
      // Exactly one row: base, snapd, and the app-typed content/daemon-only
      // snaps are not user-launchable.
      expect(result.stdout).toContain(
        "tools[1]{surface,tool,installed,version,latest,tier,in_use,apply,pin}:",
      );
      expect(result.stdout).toContain(
        "  snap,firefox,true,154.0.1-1,156.0-1,major,false,sudo snap refresh firefox,null",
      );
      expect(result.stdout).toContain(
        "summary:\n  tools: 1\n  gaps: 1\n  major: 1",
      );
      // A scoped report-only status hints the row's own command, never apply.
      expect(result.stdout).toContain(
        "Run `sudo snap refresh firefox` yourself: snap is report-only",
      );
      expect(result.stdout).not.toContain("Run `upkeep-axi apply");
      // Only GETs, at the three documented read paths (system-info answers
      // detect and status both) - never the store-wide /v2/find?name=
      // channel map, and never a mutating method.
      expect(fixture.requests).toEqual([
        "GET /v2/system-info",
        "GET /v2/system-info",
        "GET /v2/snaps",
        "GET /v2/find?select=refresh",
      ]);
    });
  });

  it("matches an esr/stable snap only to the candidate snapd offers it", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      pinSnapSurface(fake, fixture);
      queueReads(
        fixture,
        [
          firefoxSnap({
            version: "140.16.0esr-1",
            revision: "8928",
            "tracking-channel": "esr/stable",
          }),
        ],
        [
          {
            name: "some-other-snap",
            version: "2.0.0",
            revision: "20",
          },
          {
            name: "firefox",
            version: "140.18.0esr-2",
            revision: "8941",
            "tracking-channel": "esr/stable",
          },
        ],
      );
      const result = await runCli(["status", "--surface", "snap"], fake.env());
      expect(result.code).toBe(0);
      // The candidate is snapd's own tracked-channel selection, taken by
      // name; the store-wide channel map is never consulted.
      expect(result.stdout).toContain(
        "  snap,firefox,true,140.16.0esr-1,140.18.0esr-2,minor,false,sudo snap refresh firefox,null",
      );
    });
  });

  it("reports a revision-only refresh as a major gap with the same version string", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      pinSnapSurface(fake, fixture);
      queueReads(
        fixture,
        [firefoxSnap({ version: "156.0-1", revision: "8803" })],
        [{ ...FIREFOX_CANDIDATE }],
      );
      const result = await runCli(["status", "--surface", "snap"], fake.env());
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        "  snap,firefox,true,156.0-1,156.0-1,major,false,sudo snap refresh firefox,null",
      );
    });
  });

  it("keeps latest and tier absent when snapd offers no candidate", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      pinSnapSurface(fake, fixture);
      queueReads(
        fixture,
        [firefoxSnap({ version: "156.0-1", revision: "8929" })],
        [],
      );
      const result = await runCli(["status", "--surface", "snap"], fake.env());
      expect(result.code).toBe(0);
      // No candidate, no invented currentness: latest and tier stay absent,
      // and the row keeps its manual command.
      expect(result.stdout).toContain(
        "  snap,firefox,true,156.0-1,null,null,false,sudo snap refresh firefox,null",
      );
      expect(result.stdout).toContain("gaps: 0");
    });
  });

  it("keeps a held or refresh-inhibited snap's gap and its vendor facts", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      pinSnapSurface(fake, fixture);
      const rows = await directStatus(
        fixture,
        { ok: SYSTEM_INFO },
        {
          ok: [
            firefoxSnap({
              hold: "2026-10-01T00:00:00Z",
              "refresh-inhibit": "2026-09-25T00:00:00Z",
            }),
          ],
        },
        { ok: [FIREFOX_CANDIDATE] },
      );
      expect(rows).toHaveLength(1);
      const row = rows[0];
      // A hold is a vendor fact, never an error and never a suppressed gap.
      expect(row.tier).toBe("major");
      expect(row.latest).toBe("156.0-1");
      expect(row.error).toBeUndefined();
      expect(row.snapState).toEqual({
        channel: "latest/stable",
        revision: "8803",
        availableRevision: "8929",
        hold: "2026-10-01T00:00:00Z",
        refreshInhibit: "2026-09-25T00:00:00Z",
      });
      // And end to end the gap still renders; the hold facts are internal
      // until the snap_state[] slice renders them.
      queueReads(
        fixture,
        [
          firefoxSnap({
            hold: "2026-10-01T00:00:00Z",
            "refresh-inhibit": "2026-09-25T00:00:00Z",
          }),
        ],
        [FIREFOX_CANDIDATE],
      );
      const result = await runCli(["status", "--surface", "snap"], fake.env());
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        "  snap,firefox,true,154.0.1-1,156.0-1,major,false,sudo snap refresh firefox,null",
      );
      expect(result.stdout).toContain("major: 1");
    });
  });

  it("derives the executable root from the snap's mount dir", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      const rows = await directStatus(
        fixture,
        { ok: { ...SYSTEM_INFO, "snap-mount-dir": "/wsl/snap" } },
        { ok: [firefoxSnap()] },
        { ok: [FIREFOX_CANDIDATE] },
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].executables).toBeUndefined();
      // A snap app runs under <mount-dir>/<name>/<revision>/..., never at
      // the launcher symlink on PATH.
      expect(rows[0].executableRoots).toEqual(["/wsl/snap/firefox"]);
    });
  });

  it("defaults the executable root to /snap when system-info names no mount dir", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      const rows = await directStatus(
        fixture,
        { ok: SYSTEM_INFO },
        { ok: [firefoxSnap()] },
        { ok: [] },
      );
      expect(rows[0].executableRoots).toEqual(["/snap/firefox"]);
    });
  });

  it("a configured daemon-only snap is inventoried; a configured missing one reports installed=false", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      pinSnapSurface(fake, fixture, {
        tools: [{ name: "mesa-2404" }, { name: "ghost-snap" }],
      });
      queueReads(
        fixture,
        [
          firefoxSnap(),
          {
            name: "mesa-2404",
            status: "active",
            type: "app",
            version: "25.2.8-snap288",
            revision: "1839",
            "tracking-channel": "latest/stable",
            apps: [{ name: "component-monitor", daemon: "simple" }],
          },
        ],
        [FIREFOX_CANDIDATE],
      );
      const result = await runCli(["status", "--surface", "snap"], fake.env());
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        "tools[3]{surface,tool,installed,version,latest,tier,in_use,apply,pin}:",
      );
      // The configured name overrides the launchability filter: installed,
      // not installed=false.
      expect(result.stdout).toContain(
        "  snap,mesa-2404,true,25.2.8-snap288,null,null,false,sudo snap refresh mesa-2404,null",
      );
      // A configured snap the manager does not know reports its absence.
      expect(result.stdout).toContain(
        "  snap,ghost-snap,false,null,null,null,null,null,null",
      );
    });
  });

  it("reports an absent socket as the one-row absent manager, with no error", async () => {
    const fake = stdEnv();
    // No fixture: the default fake env pins an absent socket path.
    const result = await runCli(["status", "--surface", "snap"], fake.env());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "tools[1]{surface,tool,installed,version,latest,tier,in_use,apply,pin}:",
    );
    expect(result.stdout).toContain(
      "  snap,snap,false,null,null,null,null,null,null",
    );
    expect(result.stdout).not.toContain("errors[");
  });

  it("detect is false for an absent socket and true when snapd answers", async () => {
    const fake = stdEnv();
    expect(await snapSurface.detect(surfaceCtx(joinAbsent(fake)))).toBe(false);
    await withFixture(fake, async (fixture) => {
      fixture.queue({ ok: SYSTEM_INFO });
      expect(await snapSurface.detect(surfaceCtx(fixture.socketPath))).toBe(
        true,
      );
    });
  });

  it("reports a non-200 read after detection as one probe error and no rows", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      pinSnapSurface(fake, fixture);
      fixture.queue(
        { ok: SYSTEM_INFO },
        { ok: SYSTEM_INFO },
        {
          httpStatus: 500,
          body: '{"type":"error","status-code":500,"status":"Internal Server Error","result":null}',
        },
      );
      const result = await runCli(["status", "--surface", "snap"], fake.env());
      expect(result.code).toBe(0);
      // One manager row (with the surviving system-info version), no
      // fabricated inventory.
      expect(result.stdout).toContain(
        "tools[1]{surface,tool,installed,version,latest,tier,in_use,apply,pin}:",
      );
      expect(result.stdout).toContain(
        "  snap,snap,true,2.76.3,null,null,null,null,null",
      );
      expect(result.stdout).toContain(
        "errors[1]{surface,tool,detail}:\n  snap,snap,GET /v2/snaps returned snapd status 500 (Internal Server Error)",
      );
      // The failed read was never a refresh or store read.
      expect(fixture.requests).toEqual([
        "GET /v2/system-info",
        "GET /v2/system-info",
        "GET /v2/snaps",
      ]);
    });
  });

  it("reports a system-info failure at detect time as a probe error, not absence", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      pinSnapSurface(fake, fixture);
      // Both detect's read and status's read hit the same failure.
      fixture.queue(
        { httpStatus: 502, body: "Bad Gateway" },
        { httpStatus: 502, body: "Bad Gateway" },
      );
      const result = await runCli(["status", "--surface", "snap"], fake.env());
      expect(result.code).toBe(0);
      // Something answered the socket, so this is a probe error carrying
      // the client's reason verbatim - never the absent-manager row.
      expect(result.stdout).toContain(
        "  snap,snap,true,null,null,null,null,null,null",
      );
      expect(result.stdout).toContain(
        "errors[1]{surface,tool,detail}:\n  snap,snap,GET /v2/system-info returned HTTP 502 with an unparseable body",
      );
    });
  });

  it("keeps the inventory when only the refresh-candidate read fails", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      pinSnapSurface(fake, fixture);
      fixture.queue(
        { ok: SYSTEM_INFO },
        { ok: SYSTEM_INFO },
        { ok: [firefoxSnap()] },
        { httpStatus: 500, body: "boom" },
      );
      const result = await runCli(["status", "--surface", "snap"], fake.env());
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        "tools[2]{surface,tool,installed,version,latest,tier,in_use,apply,pin}:",
      );
      // The error row and the installed rows survive; latest and tier stay
      // absent because snapd offered this host no candidate.
      expect(result.stdout).toContain(
        "  snap,snap,true,2.76.3,null,null,null,null,null",
      );
      expect(result.stdout).toContain(
        "  snap,firefox,true,154.0.1-1,null,null,false,sudo snap refresh firefox,null",
      );
      expect(result.stdout).toContain(
        "errors[1]{surface,tool,detail}:\n  snap,snap,GET /v2/find?select=refresh returned HTTP 500 with an unparseable body",
      );
    });
  });

  it("refuses to apply snap as report-only, quoting the manual command", async () => {
    const fake = stdEnv();
    const result = await runCli(["apply", "snap"], fake.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "snap is report-only: upkeep-axi never runs snap, even with sudo",
    );
    expect(result.stdout).toContain(
      "Run the `sudo snap refresh <name>` command from status yourself",
    );
  });

  it("apply --all never plans a snap gap", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      pinSnapSurface(fake, fixture);
      queueReads(fixture, [firefoxSnap()], [FIREFOX_CANDIDATE]);
      const result = await runCli(
        ["apply", "--all", "--tier", "major", "--json"],
        fake.env(),
      );
      expect(result.code).toBe(0);
      const model = JSON.parse(result.stdout) as {
        mode: string;
        plan: Array<{ surface: string; tool: string }>;
      };
      expect(model.mode).toBe("plan");
      // Other surfaces' gaps plan; snap's gap never does.
      expect(model.plan.length).toBeGreaterThan(0);
      expect(model.plan.some((row) => row.surface === "snap")).toBe(false);
    });
  });
});

describe("snapTier", () => {
  it.each([
    // Parseable forward versions decide severity.
    ["154.0.1-1", "8803", "156.0-1", "8929", "major"],
    ["140.16.0esr-1", "8928", "140.18.0esr-2", "8941", "minor"],
    ["1.0.0", "1", "1.0.1", "2", "patch"],
    // A differing revision proves a real update when the versions cannot:
    // equal, backward, or unparseable all read as the conservative major.
    ["156.0-1", "8803", "156.0-1", "8929", "major"],
    ["2.0.0", "10", "1.9.9", "11", "major"],
    ["0+git.abc", "164", "0+git.def", "165", "major"],
    ["154.0.1-1", "8803", "0+git.def", "8929", "major"],
    // No offered version and no differing revision proves nothing.
    ["156.0-1", "8929", undefined, undefined, undefined],
    ["156.0-1", "8929", "156.0-1", "8929", undefined],
    ["156.0-1", "8929", undefined, "8929", undefined],
    // A differing revision with no offered version is still a proved update.
    ["156.0-1", "8929", undefined, "9000", "major"],
  ])(
    "tiers %j rev %j -> %j rev %j as %j",
    (installed, installedRev, offered, offeredRev, expected) => {
      expect(snapTier(installed, installedRev, offered, offeredRev)).toBe(
        expected,
      );
    },
  );
});

/** The fake env's pinned absent socket path, spelled the way the helper does. */
function joinAbsent(fake: FakeEnv): string {
  return `${fake.root}/no-snapd.socket`;
}

/** Three fixture PATH dirs: the snap bin dir and two other bin dirs. */
function binDirs(fake: FakeEnv): {
  snapbin: string;
  otherbin: string;
  thirdbin: string;
} {
  const snapbin = join(fake.root, "snapbin");
  const otherbin = join(fake.root, "otherbin");
  const thirdbin = join(fake.root, "thirdbin");
  for (const dir of [snapbin, otherbin, thirdbin]) {
    mkdirSync(dir, { recursive: true });
  }
  return { snapbin, otherbin, thirdbin };
}

/** system-info naming a fixture snap bin dir. */
function infoWithBinDir(snapbin: string): Record<string, unknown> {
  return { ...SYSTEM_INFO, "snap-bin-dir": snapbin };
}

/** Queue the standard four reads with a snap bin dir on the status reads. */
function queueWithBinDir(
  fixture: SnapdFixture,
  snapbin: string,
  snap: unknown,
  candidates: unknown,
): void {
  const info = infoWithBinDir(snapbin);
  fixture.queue({ ok: info }, { ok: info }, { ok: [snap] }, { ok: candidates });
}

/** The TOON body: everything before the help block. */
function toonBody(stdout: string): string {
  return stdout.slice(0, stdout.indexOf("\nhelp["));
}

describe("snap overlap and snap_state (schema v4)", () => {
  it("reports the motivating state: the duplicate firefox beside the snap launcher", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      const { snapbin, otherbin } = binDirs(fake);
      fake.writeFakeIn(snapbin, "firefox", "exit 0");
      fake.writeFakeIn(otherbin, "firefox", "exit 0");
      pinSnapSurface(fake, fixture);
      queueWithBinDir(fixture, snapbin, firefoxSnap(), [FIREFOX_CANDIDATE]);
      const result = await runCli(["status", "--surface", "snap"], {
        ...fake.env(),
        PATH: `${snapbin}:${otherbin}:${fake.binDir}`,
      });
      expect(result.code).toBe(0);
      // The row, verbatim as the plan proposes it for this state.
      expect(result.stdout).toContain(
        "  snap,firefox,true,154.0.1-1,156.0-1,major,false,sudo snap refresh firefox,null",
      );
      // skew[] cannot express this state; overlap[] does, claiming only the
      // measured paths and never naming the other copy's owner. The snap's
      // other app (geckodriver) has no PATH copy and contributes nothing.
      expect(result.stdout).toContain(
        "overlap[1]{surface,tool,command,resolvedPath,otherPath}:\n" +
          `  snap,firefox,firefox,${snapbin}/firefox,${otherbin}/firefox`,
      );
      // The retained vendor facts, displayed for the first time. TOON
      // quotes the numeric revision strings.
      expect(result.stdout).toContain(
        "snap_state[1]{surface,tool,channel,revision,available_revision,held_until,refresh_inhibited_until}:\n" +
          '  snap,firefox,latest/stable,"8803","8929",null,null',
      );
      // The bin dir came from the same system-info read: no extra request.
      expect(fixture.requests).toEqual([
        "GET /v2/system-info",
        "GET /v2/system-info",
        "GET /v2/snaps",
        "GET /v2/find?select=refresh",
      ]);
    });
  });

  it("reports a non-default app through its bare alias beside another copy", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      const { snapbin, otherbin } = binDirs(fake);
      // snapd's layout for firefox: the bare default launcher, the
      // qualified geckodriver launcher, and the bare alias linking to it.
      fake.writeFakeIn(snapbin, "firefox", "exit 0");
      fake.writeFakeIn(snapbin, "firefox.geckodriver", "exit 0");
      symlinkSync("firefox.geckodriver", join(snapbin, "geckodriver"));
      fake.writeFakeIn(otherbin, "geckodriver", "exit 0");
      pinSnapSurface(fake, fixture);
      queueWithBinDir(fixture, snapbin, firefoxSnap(), [FIREFOX_CANDIDATE]);
      const result = await runCli(["status", "--surface", "snap"], {
        ...fake.env(),
        PATH: `${snapbin}:${otherbin}:${fake.binDir}`,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        "overlap[1]{surface,tool,command,resolvedPath,otherPath}:\n" +
          `  snap,firefox,geckodriver,${snapbin}/geckodriver,${otherbin}/geckodriver`,
      );
    });
  });

  it("never claims a bare name that is not this snap's alias", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      const { snapbin, otherbin } = binDirs(fake);
      fake.writeFakeIn(snapbin, "firefox", "exit 0");
      fake.writeFakeIn(snapbin, "firefox.geckodriver", "exit 0");
      // A bare geckodriver launcher in the snap bin dir that is another
      // snap's, not an alias of firefox.geckodriver.
      fake.writeFakeIn(snapbin, "geckodriver", "exit 0");
      fake.writeFakeIn(otherbin, "geckodriver", "exit 0");
      pinSnapSurface(fake, fixture);
      queueWithBinDir(fixture, snapbin, firefoxSnap(), [FIREFOX_CANDIDATE]);
      const result = await runCli(["status", "--surface", "snap"], {
        ...fake.env(),
        PATH: `${snapbin}:${otherbin}:${fake.binDir}`,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain("overlap[");
    });
  });

  it("emits no overlap when two PATH names resolve to one launcher", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      const { snapbin, otherbin, thirdbin } = binDirs(fake);
      fake.writeFakeIn(snapbin, "firefox", "exit 0");
      symlinkSync(join(snapbin, "firefox"), join(otherbin, "firefox"));
      symlinkSync(join(snapbin, "firefox"), join(thirdbin, "firefox"));
      pinSnapSurface(fake, fixture);
      queueWithBinDir(fixture, snapbin, firefoxSnap(), [FIREFOX_CANDIDATE]);
      const result = await runCli(["status", "--surface", "snap"], {
        ...fake.env(),
        PATH: `${snapbin}:${otherbin}:${thirdbin}:${fake.binDir}`,
      });
      expect(result.code).toBe(0);
      // Aliases of the launcher are the same executable: no overlap row.
      expect(result.stdout).not.toContain("overlap[");
      expect(result.stdout).toContain("snap_state[1]");
    });
  });

  it("emits no overlap[] block at all when no other copy exists", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      const { snapbin } = binDirs(fake);
      fake.writeFakeIn(snapbin, "firefox", "exit 0");
      pinSnapSurface(fake, fixture);
      const reads = [
        { ok: infoWithBinDir(snapbin) },
        { ok: infoWithBinDir(snapbin) },
        { ok: [firefoxSnap()] },
        { ok: [FIREFOX_CANDIDATE] },
      ];
      // Two runs against one fixture: TOON first, then JSON, each making
      // the standard four reads.
      fixture.queue(...reads, ...reads);
      const toon = await runCli(["status", "--surface", "snap"], {
        ...fake.env(),
        PATH: `${snapbin}:${fake.binDir}`,
      });
      expect(toon.code).toBe(0);
      expect(toon.stdout).not.toContain("overlap[");
      const json = await runCli(["status", "--surface", "snap", "--json"], {
        ...fake.env(),
        PATH: `${snapbin}:${fake.binDir}`,
      });
      const model = JSON.parse(json.stdout) as Record<string, unknown>;
      expect("overlap" in model).toBe(false);
      expect("snap_state" in model).toBe(true);
    });
  });

  it("finds no overlap when system-info names no snap bin dir", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      // Two firefox copies on PATH, but neither is provably the snap's:
      // the default /snap/bin is not on the fixture PATH, so the
      // snap-owned candidate cannot be identified.
      const { snapbin, otherbin } = binDirs(fake);
      fake.writeFakeIn(snapbin, "firefox", "exit 0");
      fake.writeFakeIn(otherbin, "firefox", "exit 0");
      pinSnapSurface(fake, fixture);
      queueReads(fixture, [firefoxSnap()], [FIREFOX_CANDIDATE]);
      const result = await runCli(["status", "--surface", "snap"], {
        ...fake.env(),
        PATH: `${snapbin}:${otherbin}:${fake.binDir}`,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain("overlap[");
    });
  });

  it("a held snap shows its hold in snap_state while its row still carries its gap", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      pinSnapSurface(fake, fixture);
      queueReads(
        fixture,
        [
          firefoxSnap({
            hold: "2026-10-01T00:00:00Z",
            "refresh-inhibit": { "proceed-time": "2026-09-25T00:00:00Z" },
          }),
        ],
        [FIREFOX_CANDIDATE],
      );
      const result = await runCli(["status", "--surface", "snap"], fake.env());
      expect(result.code).toBe(0);
      // The hold is a displayed vendor fact, never an error and never a
      // suppressed gap. TOON quotes the revision and timestamp strings.
      expect(result.stdout).toContain(
        "snap_state[1]{surface,tool,channel,revision,available_revision,held_until,refresh_inhibited_until}:\n" +
          '  snap,firefox,latest/stable,"8803","8929","2026-10-01T00:00:00Z","2026-09-25T00:00:00Z"',
      );
      expect(result.stdout).toContain(
        "  snap,firefox,true,154.0.1-1,156.0-1,major,false,sudo snap refresh firefox,null",
      );
      expect(result.stdout).not.toContain("errors[");
    });
  });

  it("maps gating-hold to held_until when no user hold exists", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      pinSnapSurface(fake, fixture);
      queueReads(
        fixture,
        [firefoxSnap({ "gating-hold": "2026-11-01T00:00:00Z" })],
        [FIREFOX_CANDIDATE],
      );
      const result = await runCli(
        ["status", "--surface", "snap", "--json"],
        fake.env(),
      );
      expect(result.code).toBe(0);
      const model = JSON.parse(result.stdout) as {
        snap_state?: Array<Record<string, unknown>>;
      };
      expect(model.snap_state).toEqual([
        {
          surface: "snap",
          tool: "firefox",
          channel: "latest/stable",
          revision: "8803",
          available_revision: "8929",
          held_until: "2026-11-01T00:00:00Z",
        },
      ]);
    });
  });

  it("leaves hold fields absent when snapd sends undocumented shapes", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      pinSnapSurface(fake, fixture);
      queueReads(
        fixture,
        [
          firefoxSnap({
            hold: { until: "2026-10-01T00:00:00Z" },
            "refresh-inhibit": "2026-09-25T00:00:00Z",
          }),
        ],
        [FIREFOX_CANDIDATE],
      );
      const result = await runCli(
        ["status", "--surface", "snap", "--json"],
        fake.env(),
      );
      expect(result.code).toBe(0);
      const model = JSON.parse(result.stdout) as {
        errors?: unknown[];
        snap_state?: Array<Record<string, unknown>>;
      };
      // A shape snapd does not document is never an error; the display
      // fields stay absent and the verbatim values remain on the row.
      expect(model.errors).toBeUndefined();
      expect(model.snap_state?.[0]?.held_until).toBeUndefined();
      expect(model.snap_state?.[0]?.refresh_inhibited_until).toBeUndefined();
      expect(model.snap_state?.[0]?.channel).toBe("latest/stable");
    });
  });

  it("renders overlap and snap_state identically in TOON and JSON", async () => {
    const fake = stdEnv();
    await withFixture(fake, async (fixture) => {
      const { snapbin, otherbin } = binDirs(fake);
      fake.writeFakeIn(otherbin, "firefox", "exit 0");
      pinSnapSurface(fake, fixture);
      const reads = [
        { ok: infoWithBinDir(snapbin) },
        { ok: infoWithBinDir(snapbin) },
        {
          ok: [
            firefoxSnap({
              hold: "2026-10-01T00:00:00Z",
              "refresh-inhibit": { "proceed-time": "2026-09-25T00:00:00Z" },
            }),
          ],
        },
        { ok: [FIREFOX_CANDIDATE] },
      ];
      fixture.queue(...reads, ...reads);
      const toon = await runCli(["status", "--surface", "snap"], {
        ...fake.env(),
        PATH: `${snapbin}:${otherbin}:${fake.binDir}`,
      });
      const json = await runCli(["status", "--surface", "snap", "--json"], {
        ...fake.env(),
        PATH: `${snapbin}:${otherbin}:${fake.binDir}`,
      });
      const model = JSON.parse(json.stdout) as {
        overlap?: Array<Record<string, unknown>>;
        snap_state?: Array<Record<string, unknown>>;
      };
      const decoded = decode(toonBody(toon.stdout)) as {
        overlap?: Array<Record<string, unknown>>;
        snap_state?: Array<Record<string, unknown>>;
      };
      // Every field is set in this fixture, so absent-vs-null cannot hide
      // a spelling difference between the two renderers.
      expect(decoded.overlap).toEqual(model.overlap);
      expect(decoded.snap_state).toEqual(model.snap_state);
    });
  });
});
