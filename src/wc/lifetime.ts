/**
 * How long a wallet pairing is allowed to live.
 *
 * A pairing does not protect funds; every transaction still needs the phone.
 * What a stale one can do is let whoever holds the server-side record raise
 * prompts on that phone and see which wallet is attached. The lifetime is the
 * knob on that exposure, and the user picks it on the pairing page, out of
 * reach of the model.
 */

import type { StoredWalletSession } from "./store.js";

export type PairingMode = "persistent" | "once";

/** Matches WalletConnect's own default session lifetime; we can be shorter, never longer. */
export const PERSISTENT_TTL_SECONDS = 7 * 24 * 60 * 60;

/** A "just this once" pairing that is never used still goes away on its own. */
export const ONCE_TTL_SECONDS = 15 * 60;

export const DEFAULT_MODE: PairingMode = "persistent";

export function isPairingMode(value: unknown): value is PairingMode {
  return value === "persistent" || value === "once";
}

export function expiryFor(mode: PairingMode, nowSeconds: number): number {
  return nowSeconds + (mode === "once" ? ONCE_TTL_SECONDS : PERSISTENT_TTL_SECONDS);
}

/**
 * Records written before lifetimes existed carry no expiresAt. They are
 * treated as persistent and aged from their createdAt, so an old pairing
 * still expires rather than living forever by omission.
 */
export function expiresAtOf(record: Pick<StoredWalletSession, "expiresAt" | "createdAt">): number {
  if (typeof record.expiresAt === "number") return record.expiresAt;
  const created = Math.floor(new Date(record.createdAt).getTime() / 1000);
  return Number.isFinite(created) ? created + PERSISTENT_TTL_SECONDS : 0;
}

export function isExpired(
  record: Pick<StoredWalletSession, "expiresAt" | "createdAt">,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  return expiresAtOf(record) <= nowSeconds;
}
