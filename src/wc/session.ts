/**
 * On-disk WalletConnect session. No MCP imports.
 *
 * Stored at $MOI_MCP_HOME/session.json, 0600. It holds no key material — only
 * the session topic, the paired account, and the chain — but it is still the
 * handle to a wallet, so it is written restrictively.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { MoiError } from "../moi-error.js";
import { ErrorCode, SessionStore, type Network } from "../schema.js";

export type Session = SessionStore;

export function sessionPath(home: string): string {
  return join(home, "session.json");
}

export function loadSession(home: string): Session | undefined {
  const file = sessionPath(home);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = SessionStore.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function saveSession(home: string, session: Session): void {
  const file = sessionPath(home);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

export function clearSession(home: string): void {
  rmSync(sessionPath(home), { force: true });
}

/** WalletConnect expiry is unix seconds. */
export function isExpired(session: Session, nowMs = Date.now()): boolean {
  return session.expiry * 1000 <= nowMs;
}

export interface Validity {
  valid: boolean;
  reason?: "expired" | "network_mismatch";
  message?: string;
}

/**
 * A session is usable only if it has not expired AND its chain matches the
 * network this server is configured for. Sending an interaction built for one
 * network to a wallet sitting on another is the failure mode this guards.
 */
export function checkValidity(
  session: Session | undefined,
  expectedNetwork: Network,
  nowMs = Date.now(),
): Validity {
  if (!session) return { valid: false };
  if (isExpired(session, nowMs)) {
    return { valid: false, reason: "expired", message: "The wallet session has expired. Pair again." };
  }
  if (session.network !== expectedNetwork) {
    return {
      valid: false,
      reason: "network_mismatch",
      message:
        `The paired wallet is on ${session.network} but this server is configured for ` +
        `${expectedNetwork}. Switch networks in MOI Wallet, or set MOI_NETWORK=${session.network}.`,
    };
  }
  return { valid: true };
}

/** Throwing form used by the write tools. */
export function requireSession(
  session: Session | undefined,
  expectedNetwork: Network,
  nowMs = Date.now(),
): Session {
  const check = checkValidity(session, expectedNetwork, nowMs);
  if (check.valid && session) return session;

  if (check.reason === "network_mismatch") {
    throw new MoiError(ErrorCode.NETWORK_MISMATCH, check.message ?? "Network mismatch.", {
      sessionNetwork: session?.network,
      expectedNetwork,
    });
  }
  throw new MoiError(
    ErrorCode.WALLET_NOT_CONNECTED,
    check.reason === "expired"
      ? (check.message ?? "Session expired.")
      : "No MOI Wallet is paired. Call moi_connect_wallet and scan the QR code with MOI Wallet.",
  );
}
