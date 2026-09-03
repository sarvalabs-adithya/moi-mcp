/**
 * Persistence. Clients and tokens are files under <dataDir>/auth/{clients,tokens}/,
 * mode 0600, directories 0700. Authorization codes are short-lived (60s) and
 * single-use, so they live in memory only — nothing worth persisting survives
 * a process restart anyway (the pending consent screen does not either).
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync, readdirSync} from "node:fs";
import { join } from "node:path";

import type { PendingCode, StoredClientRecord, StoredTokenRecord } from "./types.js";
import { isSafePathSegment } from "./util.js";

const CODE_TTL_MS = 60_000;

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeJsonSecure(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
}

function readJsonSafe<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function deleteQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export class ClientStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "auth", "clients");
    ensureDir(this.dir);
  }

  save(record: StoredClientRecord): void {
    writeJsonSecure(join(this.dir, `${record.clientId}.json`), record);
  }

  /** clientId is attacker-controlled (query string / form body) — validate before touching the fs. */
  get(clientId: string): StoredClientRecord | undefined {
    if (!isSafePathSegment(clientId)) return undefined;
    return readJsonSafe<StoredClientRecord>(join(this.dir, `${clientId}.json`));
  }
}

export class TokenStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "auth", "tokens");
    ensureDir(this.dir);
  }

  /** hash is always our own sha256Hex() output — safe by construction, no path-traversal risk. */
  private path(hash: string): string {
    return join(this.dir, `${hash}.json`);
  }

  save(hash: string, record: StoredTokenRecord): void {
    writeJsonSecure(this.path(hash), record);
  }

  get(hash: string): StoredTokenRecord | undefined {
    return readJsonSafe<StoredTokenRecord>(this.path(hash));
  }

  delete(hash: string): void {
    deleteQuiet(this.path(hash));
  }

  /**
   * Remove every token file past its expiry. Deletion is otherwise lazy,
   * happening only when an expired token is presented, so a token that is
   * never presented again would sit on disk forever. Returns how many went.
   */
  sweepExpired(nowSeconds: number = Math.floor(Date.now() / 1000)): number {
    let removed = 0;
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      // A file we cannot parse is skipped, never fatal: one corrupt token
      // must not stop every other expired one from being cleaned up.
      let record: StoredTokenRecord | undefined;
      try {
        record = readJsonSafe<StoredTokenRecord>(join(this.dir, name));
      } catch {
        continue;
      }
      if (record && typeof record.expiresAt === "number" && record.expiresAt <= nowSeconds) {
        deleteQuiet(join(this.dir, name));
        removed += 1;
      }
    }
    return removed;
  }
}

/** In-memory, single-use, 60s-TTL authorization codes. */
export class CodeStore {
  private readonly codes = new Map<string, PendingCode>();
  private readonly ttlMs: number;

  constructor(ttlMs = CODE_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  create(code: string, data: Omit<PendingCode, "expiresAt" | "used">): void {
    this.codes.set(code, { ...data, expiresAt: Date.now() + this.ttlMs, used: false });
  }

  /**
   * Returns the entry once and always removes it — a code is consumed by the
   * first lookup regardless of outcome, so a second exchange attempt (replay,
   * or a client retrying after its own timeout) can never succeed even if the
   * first attempt failed validation downstream.
   */
  consume(code: string): PendingCode | undefined {
    const entry = this.codes.get(code);
    if (!entry) return undefined;
    this.codes.delete(code);
    if (entry.used || entry.expiresAt < Date.now()) return undefined;
    return entry;
  }
}
