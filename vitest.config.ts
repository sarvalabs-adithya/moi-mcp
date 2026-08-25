import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // e2e hits devnet RPC; opt in with `vitest --dir test/e2e`
    exclude: ["node_modules", "dist"],
  },
});
