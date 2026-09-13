import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 30s per test: the suite spawns the built CLI with scripted fakes that
    // answer instantly; anything slower means a probe hung on something real.
    testTimeout: 30_000,
  },
});
