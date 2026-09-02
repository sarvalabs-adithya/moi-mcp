#!/usr/bin/env node
/**
 * Build a one-click Claude Desktop install bundle (.mcpb, formerly .dxt).
 *
 * mcpb pack zips whatever directory you point it at verbatim, so packing the
 * working tree directly would ship dev dependencies (tsup, typescript,
 * vitest, ...) inside the bundle. Instead this script:
 *
 *   1. Copies the repo (source + manifest.json, minus node_modules/dist/.git)
 *      into a throwaway temp directory.
 *   2. `npm ci` there (full install — the build step below needs the dev
 *      toolchain) and `npm run build` to produce dist/.
 *   3. `npm ci --omit=dev` again to prune back to production-only
 *      node_modules, so only runtime dependencies get bundled.
 *   4. `mcpb pack` that directory into the .mcpb output.
 *
 * The working tree's own node_modules is never touched.
 *
 *   npm run bundle:mcpb                  # writes ./moi-mcp-<version>.mcpb
 *   npm run bundle:mcpb -- /path/out.mcpb  # custom output path
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(REPO_DIR, "package.json"), "utf8"));

const outArg = process.argv[2];
const outputPath = outArg
  ? path.resolve(outArg)
  : path.join(REPO_DIR, `moi-mcp-${pkg.version}.mcpb`);

function run(cmd, args, cwd) {
  console.log(`\n$ ${cmd} ${args.join(" ")}  (in ${cwd})`);
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n✗ ${cmd} ${args.join(" ")} failed (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

// 0. Validate the manifest before doing any work.
run("npx", ["-y", "@anthropic-ai/mcpb@latest", "validate", "manifest.json"], REPO_DIR);

// 1. Clean copy in a throwaway temp dir.
const buildDir = mkdtempSync(path.join(tmpdir(), "moi-mcp-mcpb-"));
console.log(`\nBuilding bundle in ${buildDir}`);

const SKIP = new Set(["node_modules", "dist", ".git", ".env", ".moi-mcp"]);
mkdirSync(buildDir, { recursive: true });
for (const entry of readdirSync(REPO_DIR, { withFileTypes: true })) {
  if (SKIP.has(entry.name) || entry.name.endsWith(".mcpb")) continue;
  cpSync(path.join(REPO_DIR, entry.name), path.join(buildDir, entry.name), { recursive: true });
}

try {
  // 2. Full install (dev deps needed to build), then build.
  run("npm", ["ci"], buildDir);
  run("npm", ["run", "build"], buildDir);
  if (!existsSync(path.join(buildDir, "dist", "index.js"))) {
    throw new Error("dist/index.js missing after build");
  }

  // 3. Prune back to production-only node_modules for the bundle.
  run("npm", ["ci", "--omit=dev"], buildDir);

  // 4. Pack.
  run("npx", ["-y", "@anthropic-ai/mcpb@latest", "pack", buildDir, outputPath], REPO_DIR);

  const { size } = statSync(outputPath);
  console.log(`\n✓ ${outputPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
} finally {
  rmSync(buildDir, { recursive: true, force: true });
}
