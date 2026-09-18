import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runCli } from "./helpers.js";

/**
 * The one opt-in live smoke: runs real `status` against this host's real
 * managers. Never part of the default suite run - gate it with
 * `UPKEEP_AXI_LIVE_SMOKE=1`. It asserts only that every configured surface
 * answers; it never asserts particular versions, tiers, or skew.
 */
const LIVE = process.env.UPKEEP_AXI_LIVE_SMOKE === "1";

/** The fields a `tools[]` row may carry, as the README documents them. */
const DOCUMENTED_ROW_FIELDS = new Set([
  "surface",
  "tool",
  "installed",
  "version",
  "latest",
  "tier",
  "in_use",
  "apply",
  "pin",
]);

describe.skipIf(!LIVE)("live smoke: real status on this host", () => {
  it(
    "answers with a valid report from every configured surface",
    async () => {
      const result = await runCli(["status", "--json"], { ...process.env });
      expect(result.code).toBe(0);
      const model = JSON.parse(result.stdout) as {
        schemaVersion: number;
        tools: Array<
          Record<string, unknown> & {
            surface: string;
            installed: unknown;
            apply?: unknown;
          }
        >;
        errors?: Array<{ surface: string }>;
      };
      expect(model.schemaVersion).toBe(4);
      expect(Array.isArray(model.tools)).toBe(true);
      // The snap surface is accepted like any other: a snap row, when the
      // host has one, carries only the documented row shape, and its apply
      // is the exact report-only manual command. Versions, tiers, and
      // overlap are never asserted. A stat, never a connection: only the
      // status run itself talks to the socket.
      const socketPresent = existsSync("/run/snapd.socket");
      for (const row of model.tools) {
        if (row.surface !== "snap") continue;
        for (const field of Object.keys(row)) {
          expect(DOCUMENTED_ROW_FIELDS.has(field)).toBe(true);
        }
        expect(typeof row.installed).toBe("boolean");
        if (socketPresent && row.installed === true) {
          expect(row.apply).toMatch(/^sudo snap refresh /);
        }
      }
      // A host whose snapd socket is present reports no snap probe error.
      expect(
        model.errors?.some((error) => error.surface === "snap") ?? false,
      ).toBe(false);
    },
    { timeout: 120_000 },
  );
});
