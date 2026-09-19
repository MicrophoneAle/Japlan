import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    // End-to-end handler tests generate real boards through the planner; in a
    // full parallel run on a small machine they pass 5s. Slow, not stuck.
    testTimeout: 20_000,
  },
});
