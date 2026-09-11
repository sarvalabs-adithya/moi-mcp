import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // e2e hits the live devnet RPC and is gated behind MOI_E2E=1.
    // `npm test` runs unit only; `npm run test:e2e` runs the live ones.
    include: ["test/**/*.test.ts"],
    environment: "node",
    exclude: ["node_modules", "dist"],
    testTimeout: 15_000,
  },
});
