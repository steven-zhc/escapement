import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    // Removes this run's throwaway `esctest*` projects from the test log. Without
    // it the residue outlives the run, and `lingtai doctor`'s own test — which
    // asserts the whole database is green — fails on rows an earlier package's
    // tests left behind. See the file for what that looked like.
    globalSetup: ["../store/test-support/teardown.ts"],
  },
});
