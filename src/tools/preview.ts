/**
 * Confirm tokens for the hosted write tools.
 *
 * A hosted write is two calls. The first builds the interaction and returns
 * what the phone will show plus a token; the second, carrying the token,
 * sends the approval to the phone. The token is what makes the preview
 * mandatory rather than advisory: it is bound to the user, the tool, and the
 * exact arguments, it lives ten minutes, and it works once. Without it a
 * model could go straight to the phone, and the user would be tapping on
 * numbers they never saw in the chat.
 *
 * In memory on purpose. A token that outlives the process is a token nobody
 * is looking at any more; the model previews again and loses a second.
 */

import { randomBytes } from "node:crypto";

export interface PreviewEntry {
  userId: string;
  kind: string;
  /** fingerprint() of the tool arguments the preview was built from. */
  fingerprint: string;
  /** What the user was shown, so a later change in the numbers is caught. */
  details: Record<string, string>;
  expiresAt: number;
}

export const PREVIEW_TTL_MS = 10 * 60 * 1000;

/** Live tokens one user may hold; older ones are dropped first. */
const MAX_PER_USER = 8;

export class PreviewRegistry {
  private readonly entries = new Map<string, PreviewEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly maxPerUser: number;

  constructor(opts: { ttlMs?: number; now?: () => number; maxPerUser?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? PREVIEW_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.maxPerUser = opts.maxPerUser ?? MAX_PER_USER;
  }

  issue(entry: Omit<PreviewEntry, "expiresAt">): { token: string; expiresAt: number } {
    this.sweep();
    this.capUser(entry.userId);
    const token = randomBytes(9).toString("base64url");
    const expiresAt = this.now() + this.ttlMs;
    this.entries.set(token, { ...entry, expiresAt });
    return { token, expiresAt };
  }

  /**
   * Hand back the entry for a token that matches on every axis, and forget
   * it: one preview, one send. A token that belongs to someone else or to
   * different arguments is left alone, so a guess cannot burn the owner's.
   */
  redeem(
    token: string,
    expect: { userId: string; kind: string; fingerprint: string },
  ): PreviewEntry | undefined {
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(token);
      return undefined;
    }
    if (
      entry.userId !== expect.userId ||
      entry.kind !== expect.kind ||
      entry.fingerprint !== expect.fingerprint
    ) {
      return undefined;
    }
    this.entries.delete(token);
    return entry;
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [token, entry] of this.entries) if (entry.expiresAt <= t) this.entries.delete(token);
  }

  private capUser(userId: string): void {
    const mine = [...this.entries].filter(([, e]) => e.userId === userId);
    mine.sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    while (mine.length >= this.maxPerUser) this.entries.delete(mine.shift()![0]);
  }
}

/**
 * A stable string for a value: keys sorted, undefined dropped, bigints as
 * decimal strings. Two argument objects that mean the same thing get the
 * same fingerprint however the model happened to order them.
 */
export function fingerprint(value: unknown): string {
  return JSON.stringify(sortKeys(value), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(src)
        .sort()
        .map((k) => [k, sortKeys(src[k])]),
    );
  }
  return value;
}
