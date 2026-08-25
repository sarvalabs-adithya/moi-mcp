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

/** Where to get a WalletConnect project id, named everywhere we complain about it. */
export const WC_PROJECT_ID_HELP =
  "Get a free one at https://cloud.reown.com — create a project, copy its Project ID, " +
  "then set WC_PROJECT_ID in your MCP client config (the `env` block).";

/** Placeholders people leave behind after copying .env.example or a README. */
const PLACEHOLDERS = new Set([
  "replace_me",
  "replace_with_your_project_id",
  "your_project_id",
  "changeme",
  "todo",
]);

/**
 * Describe what is wrong with a project id, or undefined if it looks usable.
 *
 * Reown ids are 32 hex characters. A wrong-looking id is reported but not
 * rejected — the format is theirs to change, and a hard failure on a valid id
 * would be worse than a warning on an invalid one.
 */
export function projectIdIssue(value: string | undefined): string | undefined {
  const v = (value ?? "").trim();
  if (v === "") return `WC_PROJECT_ID is not set. ${WC_PROJECT_ID_HELP}`;
  if (PLACEHOLDERS.has(v.toLowerCase()) || /^[<{].*[>}]$/.test(v)) {
    return `WC_PROJECT_ID is still the placeholder "${v}". ${WC_PROJECT_ID_HELP}`;
  }
  if (!/^[0-9a-f]{32}$/i.test(v)) {
    return (
      `WC_PROJECT_ID does not look like a Reown project id (expected 32 hex characters, ` +
      `got ${v.length}). Pairing will probably fail. ${WC_PROJECT_ID_HELP}`
    );
  }
  return undefined;
}

/** True when the id is unusable, as opposed to merely odd-looking. */
export function projectIdIsUnusable(value: string | undefined): boolean {
  const v = (value ?? "").trim();
  return v === "" || PLACEHOLDERS.has(v.toLowerCase()) || /^[<{].*[>}]$/.test(v);
}

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

  // Catch the one that trips everyone up first, with a message that says
  // exactly where to go, rather than letting zod say "Required".
  const projectIssue = projectIdIssue(raw["WC_PROJECT_ID"]);
  if (projectIssue && projectIdIsUnusable(raw["WC_PROJECT_ID"])) {
    throw new Error(projectIssue);
  }

  const parsed = Config.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(
      `Invalid MOI MCP configuration — ${detail}. ` +
        `Set these in your MCP client config (the \`env\` block), or copy .env.example to .env.`,
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
  // Collapse to a single line: MCP clients show stderr in a cramped log pane,
  // and a wrapped stack trace buries the actionable sentence.
  const oneLine = message.replace(/\s*\n\s*/g, " ").trim();
  process.stderr.write(`[moi-mcp] ${level}: ${oneLine}\n`);
}
