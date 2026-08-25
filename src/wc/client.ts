/**
 * WalletConnect v2 transport to MOI Wallet. No MCP imports.
 *
 * This module is the only place that talks to the relay, and it never sees a
 * private key: it ships an unsigned interaction to the phone and waits for the
 * user to approve. The wallet signs and broadcasts.
 */

// NAMED import. The package's ESM entry puts the class on `SignClient`; the
// default export is the CJS module object of constants, whose `.init` is
// undefined. `import SignClient from ...` fails at runtime, not compile time.
import { SignClient } from "@walletconnect/sign-client";

import { MoiError } from "../moi-error.js";
import { ErrorCode, WC_EVENTS, WC_METHODS, type Network } from "../schema.js";
import type { UnsignedInteraction } from "../moi/ix-builder.js";
import { NETWORKS } from "../moi/provider.js";
import { clearSession, loadSession, saveSession, type Session } from "./session.js";

export const WC_NAMESPACE = "moi";

/**
 * How the interaction is placed in the WalletConnect request.
 *
 * "positional" — `params: [ixObject]`, the plain InteractionObject. This is
 *   what sarvalabs/wallet-connect-dapp does and is the default.
 * "ix_args"    — `params: [{ ix_args: <POLO hex>, meta }]`, matching
 *   schema.WcSendInteractionsParams. Kept because no public doc gives a
 *   literal request body for moi.sendInteractions (PLAN open Q1); set
 *   MOI_WC_PARAM_STYLE=ix_args to switch without a code change.
 */
export type ParamStyle = "positional" | "ix_args";

export function paramStyle(env: NodeJS.ProcessEnv = process.env): ParamStyle {
  return env["MOI_WC_PARAM_STYLE"] === "ix_args" ? "ix_args" : "positional";
}

export interface WcConfig {
  projectId: string;
  home: string;
  network: Network;
  requestTimeoutMs: number;
  /** Overrides the network's CAIP-2 chain id. */
  chainId?: string;
}

export interface PairResult {
  uri: string;
  /** Resolves when the user approves on their phone; rejects if they reject. */
  approval: Promise<Session>;
}

const METADATA = {
  name: "MOI MCP Server",
  description: "Lets an AI agent read MOI chain state and propose interactions for you to approve.",
  url: "https://moi.technology",
  icons: ["https://moi.technology/favicon.ico"],
};

/** Minimal surface we need from SignClient — lets tests inject a fake. */
export interface SignClientLike {
  connect(args: unknown): Promise<{ uri?: string; approval: () => Promise<unknown> }>;
  request<T>(args: unknown): Promise<T>;
  disconnect(args: unknown): Promise<void>;
  on(event: string, cb: (payload: unknown) => void): void;
  session: { keys: string[]; get(topic: string): unknown };
}

export class WalletConnectClient {
  private client?: SignClientLike;
  private readonly config: WcConfig;
  private readonly factory: (cfg: WcConfig) => Promise<SignClientLike>;
  /** Requests sent to the phone and not yet answered. */
  private pending = 0;

  constructor(config: WcConfig, factory?: (cfg: WcConfig) => Promise<SignClientLike>) {
    this.config = config;
    this.factory = factory ?? defaultFactory;
  }

  get pendingRequests(): number {
    return this.pending;
  }

  chainId(): string {
    return this.config.chainId ?? NETWORKS[this.config.network].caip2;
  }

  async init(): Promise<SignClientLike> {
    if (this.client) return this.client;
    try {
      this.client = await this.factory(this.config);
    } catch (err) {
      throw new MoiError(
        ErrorCode.RELAY_UNAVAILABLE,
        `Could not reach the WalletConnect relay: ${err instanceof Error ? err.message : String(err)}. ` +
          `Check WC_PROJECT_ID and your network connection.`,
      );
    }

    // The wallet can end the session from its side; drop our copy when it does.
    for (const event of ["session_delete", "session_expire"]) {
      this.client.on(event, () => clearSession(this.config.home));
    }
    return this.client;
  }

  session(): Session | undefined {
    return loadSession(this.config.home);
  }

  /** Start pairing. Returns the URI to render as a QR immediately. */
  async pair(): Promise<PairResult> {
    const client = await this.init();
    const chainId = this.chainId();

    let uri: string | undefined;
    let approval: () => Promise<unknown>;
    try {
      ({ uri, approval } = await client.connect({
        requiredNamespaces: {
          [WC_NAMESPACE]: {
            chains: [chainId],
            methods: [...WC_METHODS],
            events: [...WC_EVENTS],
          },
        },
      }));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // The relay rejects an unknown or malformed project id at publish time.
      if (/publish|project|unauthorized|403/i.test(detail)) {
        throw new MoiError(
          ErrorCode.RELAY_UNAVAILABLE,
          `The WalletConnect relay refused the pairing: ${detail}. ` +
            `This usually means WC_PROJECT_ID is missing or not a valid project id from cloud.reown.com.`,
        );
      }
      throw translateWcError(err);
    }

    if (!uri) {
      throw new MoiError(ErrorCode.RELAY_UNAVAILABLE, "WalletConnect returned no pairing URI.");
    }

    const settled = approval().then((raw) => {
      const session = toSession(raw, this.config.network, chainId);
      saveSession(this.config.home, session);
      return session;
    });

    return { uri, approval: settled };
  }

  async disconnect(reason = "User requested disconnect"): Promise<boolean> {
    const session = this.session();
    clearSession(this.config.home);
    if (!session) return false;
    try {
      const client = await this.init();
      await client.disconnect({
        topic: session.topic,
        reason: { code: 6000, message: reason },
      });
    } catch {
      // The local session is already gone; a relay failure must not block.
    }
    return true;
  }

  /**
   * Send an unsigned interaction to the phone and wait for the user.
   * Returns the interaction hash the wallet reports after broadcasting.
   */
  async sendInteraction(
    session: Session,
    ix: UnsignedInteraction,
    opts: { description?: string; poloHex?: string } = {},
  ): Promise<string> {
    const client = await this.init();
    const style = paramStyle();

    const params =
      style === "ix_args"
        ? [
            {
              ix_args: opts.poloHex ?? ix,
              meta: { dappName: METADATA.name, ...(opts.description ? { description: opts.description } : {}) },
            },
          ]
        : [ix];

    this.pending += 1;
    try {
      const raw = await withTimeout(
        client.request<unknown>({
          topic: session.topic,
          chainId: session.chainId,
          request: { method: "moi.sendInteractions", params },
        }),
        this.config.requestTimeoutMs,
      );
      return extractHash(raw);
    } catch (err) {
      throw translateWcError(err);
    } finally {
      this.pending -= 1;
    }
  }
}

// ---------------------------------------------------------------------------

async function defaultFactory(cfg: WcConfig): Promise<SignClientLike> {
  const client = await SignClient.init({
    projectId: cfg.projectId,
    metadata: METADATA,
    storageOptions: { database: `${cfg.home}/wc.db` },
  });
  return client as unknown as SignClientLike;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new MoiError(
          ErrorCode.REQUEST_TIMEOUT,
          `The wallet did not respond within ${Math.round(ms / 1000)}s. The request may still be waiting on your phone.`,
        ),
      );
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

/**
 * The wallet's response shape is not documented — the reference dapp types it
 * as an opaque string. Accept a bare hash, or an object carrying one.
 */
export function extractHash(raw: unknown): string {
  if (typeof raw === "string" && /^0x[0-9a-fA-F]+$/.test(raw.trim())) return raw.trim();
  if (raw && typeof raw === "object") {
    for (const key of ["hash", "ix_hash", "interaction_hash", "txHash", "result"]) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return value;
    }
  }
  throw new MoiError(
    ErrorCode.RPC_ERROR,
    `MOI Wallet approved the interaction but returned an unrecognised response: ${JSON.stringify(raw)?.slice(0, 200)}`,
    { raw: raw as never },
  );
}

const REJECTION = /reject|denied|declined|user closed|cancell?ed/i;

/** Map WalletConnect's error vocabulary onto ours. */
export function translateWcError(err: unknown): MoiError {
  if (err instanceof MoiError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: number } | undefined)?.code;

  // 5000/4001 are the conventional user-rejected codes.
  if (code === 5000 || code === 4001 || REJECTION.test(message)) {
    return new MoiError(ErrorCode.USER_REJECTED, "You rejected the interaction on your phone.");
  }
  if (/expired|no matching key|session topic doesn't exist/i.test(message)) {
    return new MoiError(
      ErrorCode.WALLET_NOT_CONNECTED,
      "The wallet session is no longer valid. Pair again with moi_connect_wallet.",
    );
  }
  return new MoiError(ErrorCode.RPC_ERROR, `WalletConnect request failed: ${message}`);
}

/** Normalise the settled WalletConnect session into our on-disk shape. */
export function toSession(raw: unknown, network: Network, chainId: string): Session {
  const s = raw as {
    topic?: string;
    pairingTopic?: string;
    expiry?: number;
    peer?: { metadata?: { name?: string; url?: string } };
    namespaces?: Record<string, { accounts?: string[] }>;
  };

  const accounts = s.namespaces?.[WC_NAMESPACE]?.accounts ?? [];
  // CAIP-10: "moi:14:0xabc..." — the account is the last colon-separated part.
  const account = accounts[0]?.split(":").pop() ?? "";

  if (!s.topic) {
    throw new MoiError(ErrorCode.RELAY_UNAVAILABLE, "WalletConnect session carried no topic.");
  }
  if (!/^0x[0-9a-fA-F]+$/.test(account)) {
    throw new MoiError(
      ErrorCode.WALLET_NOT_CONNECTED,
      `MOI Wallet approved but returned no usable account (got "${account}").`,
    );
  }

  return {
    version: 1,
    topic: s.topic,
    ...(s.pairingTopic ? { pairingTopic: s.pairingTopic } : {}),
    account,
    chainId,
    network,
    peer: {
      name: s.peer?.metadata?.name ?? "MOI Wallet",
      ...(s.peer?.metadata?.url ? { url: s.peer.metadata.url } : {}),
    },
    expiry: s.expiry ?? Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    createdAt: Math.floor(Date.now() / 1000),
  };
}
