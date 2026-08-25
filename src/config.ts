/**
 * Environment loading + validation.
 *
 * Rules this file exists to enforce:
 *   - stdout belongs to the MCP transport. Nothing here may write to it.
 *   - `~` in MOI_MCP_HOME is expanded and the directory is created 0700,
 *     because it holds the WalletConnect keystore and session.json.
 *   - Config is loaded lazily so the server always starts and can report
 *     *why* it is misconfigured, instead of dying before `initialize`.
 */

import { config as loadDotenv } from "dotenv";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { Config } from "./schema.js";

export type LoadedConfig = Config & {
  /** MOI_MCP_HOME with `~` expanded to an absolute path. Created on load. */
  home: string;
};

let cached: LoadedConfig | undefined;
let dotenvLoaded = false;

/** Expand a leading `~` and make the path absolute. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolve(p);
}

/**
 * Parse and validate the environment. Throws with an actionable message.
 * Pass an explicit `env` in tests to avoid touching the real process env.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  if (!dotenvLoaded && env === process.env) {
    // `quiet` suppresses dotenv's stdout banner — it would corrupt the transport.
    loadDotenv({ quiet: true });
    dotenvLoaded = true;
  }

  // Only forward keys we know about, and treat empty strings as unset so that
  // a blank line in .env falls back to the schema default instead of failing.
  const raw: Record<string, string> = {};
  for (const key of Object.keys(Config.shape)) {
    const value = env[key];
    if (typeof value === "string" && value.trim() !== "") raw[key] = value;
  }

  const parsed = Config.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid MOI MCP configuration:\n${detail}\n\n` +
        `Copy .env.example to .env and fill it in, or set these in your MCP client config.`,
    );
  }

  const cfg = parsed.data;

  // Cross-field rule the flat schema cannot express.
  if (cfg.MOI_NETWORK === "custom" && !cfg.MOI_RPC_URL) {
    throw new Error(
      `MOI_NETWORK=custom requires MOI_RPC_URL to be set to your node's JSON-RPC endpoint.`,
    );
  }

  const home = expandHome(cfg.MOI_MCP_HOME);
  // 0700: this directory holds the WalletConnect keystore and session.json.
  mkdirSync(home, { recursive: true, mode: 0o700 });

  return { ...cfg, home };
}

/** Memoised accessor. First call validates and creates MOI_MCP_HOME. */
export function getConfig(): LoadedConfig {
  cached ??= loadConfig();
  return cached;
}

/** Test seam. */
export function resetConfigCache(): void {
  cached = undefined;
  dotenvLoaded = false;
}

// ---------------------------------------------------------------------------
// Logging — stderr only, always.
// ---------------------------------------------------------------------------

const LEVELS = { silent: 0, error: 1, info: 2, debug: 3 } as const;
export type LogLevel = keyof typeof LEVELS;

/**
 * Reads LOG_LEVEL straight from the environment rather than from getConfig(),
 * so that configuration failures themselves are loggable.
 */
export function log(level: Exclude<LogLevel, "silent">, message: string): void {
  const configured = (process.env.LOG_LEVEL ?? "error") as LogLevel;
  const threshold = LEVELS[configured] ?? LEVELS.error;
  if (LEVELS[level] > threshold) return;
  process.stderr.write(`[moi-mcp] ${level}: ${message}\n`);
}
