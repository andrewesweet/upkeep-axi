import { describe, expect, it } from "vitest";
import { runCli } from "./helpers.js";

/**
 * The one opt-in live smoke: runs real `status` against this host's real
 * managers. Never part of the default suite run - gate it with
 * `UPKEEP_AXI_LIVE_SMOKE=1`. It asserts only that every configured surface
 * answers; it never asserts particular versions, tiers, or skew.
 */
const LIVE = process.env.UPKEEP_AXI_LIVE_SMOKE === "1";

describe.skipIf(!LIVE)("live smoke: real status on this host", () => {
  it(
    "answers with a valid report from every configured surface",
    async () => {
      const result = await runCli(["status", "--json"], { ...process.env });
      expect(result.code).toBe(0);
      const model = JSON.parse(result.stdout) as {
        schemaVersion: number;
        tools: unknown[];
      };
      expect(model.schemaVersion).toBe(3);
      expect(Array.isArray(model.tools)).toBe(true);
    },
    { timeout: 120_000 },
  );
});
