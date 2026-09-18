import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createEnv,
  installStandardFakes,
  runCli,
  startSnapdFixture,
  type FakeEnv,
  type SnapdFixture,
} from "./helpers.js";
import {
  DEFAULT_SNAPD_SOCKET,
  snapdRefreshCandidates,
  snapdSnaps,
  snapdSocketPath,
  snapdSystemInfo,
} from "../src/snapd.js";

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

describe("snapd client", () => {
  it("answers a healthy sync envelope with its result", async () => {
    const fake = createEnv();
    await withFixture(fake, async (fixture) => {
      const systemInfo = { version: "2.76.3", series: "16" };
      fixture.queue({ ok: systemInfo });
      const read = await snapdSystemInfo(fixture.socketPath, 2000);
      expect(read).toEqual({ kind: "ok", result: systemInfo });
      expect(fixture.requests).toEqual(["GET /v2/system-info"]);
    });
  });

  it("issues only GETs, at the three documented paths", async () => {
    const fake = createEnv();
    await withFixture(fake, async (fixture) => {
      fixture.queue({ ok: {} }, { ok: [] }, { ok: [] });
      const [info, snaps, refresh] = await Promise.all([
        snapdSystemInfo(fixture.socketPath, 2000),
        snapdSnaps(fixture.socketPath, 2000),
        snapdRefreshCandidates(fixture.socketPath, 2000),
      ]);
      expect(info.kind).toBe("ok");
      expect(snaps.kind).toBe("ok");
      expect(refresh.kind).toBe("ok");
      // The inventory read never asks for select=all (disabled historical
      // revisions), and the refresh read is select=refresh - what snapd
      // offers this host, not the store-wide channel map.
      expect(fixture.requests).toEqual([
        "GET /v2/system-info",
        "GET /v2/snaps",
        "GET /v2/find?select=refresh",
      ]);
      for (const request of fixture.requests) {
        expect(request.startsWith("GET ")).toBe(true);
      }
    });
  });

  it("classifies an absent socket file as absent, not an error", async () => {
    const fake = createEnv();
    const read = await snapdSystemInfo(
      join(fake.root, "never-created.sock"),
      2000,
    );
    expect(read.kind).toBe("absent");
    if (read.kind === "absent") {
      expect(read.reason).toContain("ENOENT");
      expect(read.reason).toContain("never-created.sock");
    }
  });

  it("classifies a socket path with no listener as absent", async () => {
    const fake = createEnv();
    // A plain file where the socket would be: connect is refused, the way
    // an installed-but-idle snapd presents.
    const socketPath = join(fake.root, "idle.sock");
    writeFileSync(socketPath, "");
    const read = await snapdSnaps(socketPath, 2000);
    expect(read.kind).toBe("absent");
    if (read.kind === "absent") {
      expect(read.reason).toContain("ECONNREFUSED");
    }
  });

  it("classifies permission denial on an existing socket as a probe error, not absence", async () => {
    const fake = createEnv();
    await withFixture(fake, async (fixture) => {
      chmodSync(fixture.socketPath, 0o000);
      try {
        const read = await snapdSystemInfo(fixture.socketPath, 2000);
        expect(read.kind).toBe("error");
        if (read.kind === "error") {
          expect(read.reason).toContain("permission denied");
          expect(read.reason).toContain(fixture.socketPath);
        }
        expect(fixture.requests).toEqual([]);
      } finally {
        chmodSync(fixture.socketPath, 0o666);
      }
    });
  });

  it("classifies invalid JSON as a probe error naming the read", async () => {
    const fake = createEnv();
    await withFixture(fake, async (fixture) => {
      fixture.queue({ httpStatus: 200, body: "<html>not json</html>" });
      const read = await snapdSystemInfo(fixture.socketPath, 2000);
      expect(read.kind).toBe("error");
      if (read.kind === "error") {
        expect(read.reason).toContain("invalid JSON");
        expect(read.reason).toContain("GET /v2/system-info");
        expect(read.statusCode).toBeUndefined();
      }
    });
  });

  it.each([
    ["a JSON array", "[]", "expected an object"],
    ["a JSON null", "null", "expected an object"],
    ["a bare string", '"hello"', "expected an object"],
    [
      "an envelope without status-code",
      '{"type":"sync"}',
      "no numeric status-code",
    ],
    [
      "a sync envelope without a result",
      '{"type":"sync","status-code":200,"status":"OK"}',
      "no result",
    ],
    [
      "an async envelope",
      '{"type":"async","status-code":200,"status":"OK","result":"42"}',
      "unexpected envelope type",
    ],
  ])(
    "classifies %s as a malformed-envelope probe error",
    async (_label, body, detail) => {
      const fake = createEnv();
      await withFixture(fake, async (fixture) => {
        fixture.queue({ httpStatus: 200, body });
        const read = await snapdSnaps(fixture.socketPath, 2000);
        expect(read.kind).toBe("error");
        if (read.kind === "error") {
          expect(read.reason).toContain("GET /v2/snaps");
          expect(read.reason).toContain(detail);
          expect(read.statusCode).toBeUndefined();
        }
      });
    },
  );

  it("classifies a non-200 envelope status as a probe error carrying the status", async () => {
    const fake = createEnv();
    await withFixture(fake, async (fixture) => {
      fixture.queue({
        httpStatus: 404,
        body: '{"type":"error","status-code":404,"status":"Not Found","result":null}',
      });
      const read = await snapdRefreshCandidates(fixture.socketPath, 2000);
      expect(read.kind).toBe("error");
      if (read.kind === "error") {
        expect(read.statusCode).toBe(404);
        expect(read.reason).toContain("snapd status 404 (Not Found)");
      }
    });
  });

  it("classifies a non-200 HTTP status with an unparseable body as a probe error", async () => {
    const fake = createEnv();
    await withFixture(fake, async (fixture) => {
      fixture.queue({ httpStatus: 502, body: "Bad Gateway" });
      const read = await snapdSnaps(fixture.socketPath, 2000);
      expect(read.kind).toBe("error");
      if (read.kind === "error") {
        expect(read.statusCode).toBe(502);
        expect(read.reason).toContain("HTTP 502");
      }
    });
  });

  it("classifies a daemon that never answers as a probe error at the budget", async () => {
    const fake = createEnv();
    await withFixture(fake, async (fixture) => {
      fixture.queue({ hang: true });
      const read = await snapdSnaps(fixture.socketPath, 200);
      expect(read.kind).toBe("error");
      if (read.kind === "error") {
        expect(read.reason).toContain("timed out after 200ms");
      }
      // The request did reach the fixture; the fixture just never answered.
      expect(fixture.requests).toEqual(["GET /v2/snaps"]);
    });
  });
});

describe("snapd test seam", () => {
  it("resolves the socket path from config, defaulting to /run/snapd.socket", () => {
    expect(snapdSocketPath({})).toBe("/run/snapd.socket");
    expect(snapdSocketPath({ socketPath: "/tmp/other.sock" })).toBe(
      "/tmp/other.sock",
    );
    expect(DEFAULT_SNAPD_SOCKET).toBe("/run/snapd.socket");
  });

  it("pins every fake environment to an absent snap socket by default", () => {
    const fake = createEnv();
    const config = JSON.parse(readFileSync(fake.configPath, "utf-8")) as {
      surfaces: { snap: { socketPath: string } };
    };
    expect(config.surfaces.snap.socketPath).toBe(
      join(fake.root, "no-snapd.socket"),
    );
    expect(existsSync(config.surfaces.snap.socketPath)).toBe(false);
  });

  it("swaps the absent pin for a fixture socket via writeConfig", async () => {
    const fake = createEnv();
    await withFixture(fake, async (fixture) => {
      fake.writeConfig({
        surfaces: { snap: { socketPath: fixture.socketPath } },
      });
      const config = JSON.parse(readFileSync(fake.configPath, "utf-8")) as {
        surfaces: { snap: { socketPath: string } };
      };
      expect(config.surfaces.snap.socketPath).toBe(fixture.socketPath);
      // And the client answers through that config-pinned path.
      fixture.queue({ ok: { version: "2.76.3" } });
      const read = await snapdSystemInfo(config.surfaces.snap.socketPath, 2000);
      expect(read).toEqual({ kind: "ok", result: { version: "2.76.3" } });
    });
  });

  it("accepts a surfaces.snap config entry that only pins the socket", async () => {
    const fake = stdEnv();
    fake.writeConfig({
      surfaces: { snap: { socketPath: "/run/snapd.socket" } },
    });
    const result = await runCli(["status"], fake.env());
    expect(result.code).toBe(0);
  });

  it.each([
    ["an empty string", '""'],
    ["a number", "5"],
    ["a boolean", "true"],
  ])("rejects %s as surfaces.snap.socketPath", async (_label, literal) => {
    const fake = stdEnv();
    writeRawSnapConfig(fake, `{"snap":{"socketPath":${literal}}}`);
    const result = await runCli(["status"], fake.env());
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(
      "Config `surfaces.snap.socketPath` must be a non-empty string",
    );
  });

  it("--surface snap resolves now that the surface module registers", async () => {
    const fake = stdEnv();
    const result = await runCli(["status", "--surface", "snap"], fake.env());
    expect(result.code).toBe(0);
    // The pinned socket is absent: the one-row absent manager, no error.
    expect(result.stdout).toContain(
      "  snap,snap,false,null,null,null,null,null,null",
    );
    expect(result.stdout).not.toContain("errors[");
  });
});

/** Write a config whose surfaces block is raw JSON (bypassing the pin). */
function writeRawSnapConfig(fake: FakeEnv, surfacesJson: string): void {
  writeFileSync(fake.configPath, `{"surfaces":${surfacesJson}}`);
}
