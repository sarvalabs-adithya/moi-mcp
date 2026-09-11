import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/http.ts", "src/server.ts", "src/schema.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  // src/server.ts imports buildReadOnlyServer from src/http.ts. With
  // splitting:false a plain bundle would INLINE http.ts's code — including
  // its own `if (isMain) main()` top-level guard — into dist/server.js.
  // Inlined that way, http.ts's `import.meta.url` becomes indistinguishable
  // from dist/server.js's own, so the realpath check the two entry points
  // both rely on (see src/http.ts's isMain comment) can no longer tell them
  // apart: running dist/server.js also boots http.ts's main(), opening a
  // second unmanaged listener on PORT (default 8787) — which crashes the
  // process on EADDRINUSE the moment that port is already the read-only
  // service PLAN-HOSTED.md §0½ has you run alongside it. Marking it external
  // keeps dist/http.js a separate file with its own import.meta.url, so the
  // two entry points' guards work as written.
  external: ["./http.js"],
  // stdout is the MCP transport; never let the bundler inject banners there.
  shims: true,
});
