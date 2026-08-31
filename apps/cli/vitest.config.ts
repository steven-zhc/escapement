import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // One of these opens real connections and holds a listener for 1.5s.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
