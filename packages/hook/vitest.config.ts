import { defineConfig } from "vitest/config";

export default defineConfig({
  // Compiling the binary and measuring a thousand round trips is not a 5s job.
  test: { testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false },
});
