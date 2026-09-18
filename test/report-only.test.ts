import { describe, expect, it } from "vitest";
import type { Surface } from "../src/types.js";
import {
  createEnv,
  installStandardFakes,
  runMain,
  withSurface,
  type FakeEnv,
} from "./helpers.js";

const FAKE_SURFACE_ID = "fake-ro";
/** The manual command the fake surface publishes on its rows. */
const MANUAL_COMMAND = "sudo fake-ro refresh all";

/**
 * A minimal report-only surface: one installed row with a known gap, no
 * delegate, and the reportOnly metadata. Nothing here is spelled "apt";
 * the assertions below consume only the metadata and the registry.
 */
function fakeReportOnlySurface(): Surface {
  return {
    id: FAKE_SURFACE_ID,
    description: "fake report-only surface",
    managerTool: FAKE_SURFACE_ID,
    reportOnly: { manualCommand: MANUAL_COMMAND },
    async detect() {
      return true;
    },
    async status() {
      return [
        {
          surface: FAKE_SURFACE_ID,
          tool: "widget",
          installed: true,
          version: "1.0.0",
          latest: "2.0.0",
          tier: "major",
          applyCommand: MANUAL_COMMAND,
        },
      ];
    },
    apply() {
      return undefined;
    },
  };
}

/** Run one assertion with the fake surface registered, then remove it. */
function withFakeSurface(run: () => Promise<void>): Promise<void> {
  return withSurface(fakeReportOnlySurface(), run);
}

function fakeEnv(): FakeEnv {
  const env = createEnv();
  installStandardFakes(env);
  return env;
}

describe("report-only surfaces (generic, not apt-named)", () => {
  it("naming a report-only surface for apply is a usage error quoting the manual command", async () => {
    await withFakeSurface(async () => {
      const env = fakeEnv();
      const result = await runMain(["apply", FAKE_SURFACE_ID], env);
      expect(result.code).toBe(2);
      expect(result.output).toContain(
        `${FAKE_SURFACE_ID} is report-only: upkeep-axi never runs ${FAKE_SURFACE_ID}, even with sudo`,
      );
      expect(result.output).toContain(
        `Run the \`${MANUAL_COMMAND}\` command from status yourself`,
      );
    });
  });

  it("apply --all never plans a report-only surface's known gap", async () => {
    await withFakeSurface(async () => {
      const env = fakeEnv();
      const result = await runMain(
        ["apply", "--all", "--tier", "major", "--json"],
        env,
      );
      expect(result.code).toBe(0);
      const model = JSON.parse(result.output) as {
        mode: string;
        plan: Array<{ surface: string; tool: string }>;
      };
      expect(model.mode).toBe("plan");
      // Other surfaces' gaps plan; the fake's gap never appears.
      expect(model.plan.length).toBeGreaterThan(0);
      expect(model.plan.some((row) => row.surface === FAKE_SURFACE_ID)).toBe(
        false,
      );
    });
  });

  it("a scoped report-only status with gaps hints the row's own command", async () => {
    await withFakeSurface(async () => {
      const env = fakeEnv();
      const result = await runMain(
        ["status", "--surface", FAKE_SURFACE_ID],
        env,
      );
      expect(result.code).toBe(0);
      // The row itself is there (the surface was really probed), and the
      // hint quotes the row's manual command, never apply.
      expect(result.output).toContain(`  ${FAKE_SURFACE_ID},widget,`);
      expect(result.output).not.toContain("Run `upkeep-axi apply");
      expect(result.output).toContain(
        `Run \`${MANUAL_COMMAND}\` yourself: ${FAKE_SURFACE_ID} is report-only`,
      );
    });
  });

  it("report-only-only gaps never trigger the generic apply --all hint", async () => {
    await withFakeSurface(async () => {
      const env = fakeEnv();
      const result = await runMain(
        ["status", "--surface", `${FAKE_SURFACE_ID},skills`],
        env,
      );
      expect(result.code).toBe(0);
      // Two surfaces requested, so the generic hint branch is the one at
      // stake - and every known gap belongs to the report-only surface.
      expect(result.output).toContain("Run `upkeep-axi status --json`");
      expect(result.output).not.toContain("Run `upkeep-axi apply");
    });
  });
});
