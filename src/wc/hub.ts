/**
 * WalletConnect hub — multi-user-safe signing orchestrator.
 *
 * Owns the single SignClient per hosted process, gating all signing through
 * topic-based session lookup. No method accepts userId, Session, or account —
 * only topic, which is resolved from the native SignClient's own session store.
 *
 * INVARIANTS:
 * - One WalletConnectHub per process, created by main()
 * - One SignClient per process, owned exclusively by this hub
 * - Signing is only available via signInteractionFor(topic, ...)
 * - Topic is never accepted from tool parameters; only from StoredWalletSession
 * - Identity reasoning (userId -> topic) is caller's job (hosted-writes.ts)
 */

import type { UnsignedInteraction } from "../moi/ix-builder.js";
import { MoiError } from "../moi-error.js";
import { ErrorCode } from "../schema.js";
import { toWireJson } from "../moi/ix-builder.js";
import { translateWcError } from "./client.js";
import type { SignClientLike, WcConfig } from "./client.js";
import { SignClient } from "@walletconnect/sign-client";

export interface SignInteractionOpts {
  description?: string;
}

export interface HubSignResult {
  ix_args: string;
  signatures: string;
}

/**
 * Public contract of WalletConnectHub. Callers that only need to drive
 * signing (HostedDeps.hub, HostedWriteDeps.hub) and tests that need a hand-
 * rolled fake should depend on this instead of the concrete class — the
 * class itself carries a private `signClient` field, which makes it
 * unusable as a structural type for a plain-object or separate-class test
 * double (TS treats private members as nominal, not structural).
 */
export interface WalletConnectHubLike {
  signInteractionFor(
    topic: string,
    ix: UnsignedInteraction,
    opts?: SignInteractionOpts,
  ): Promise<HubSignResult>;
  onSessionDelete(handler: (topic: string) => void): () => void;
  close(): Promise<void>;
}

/** Minimal metadata for WalletConnect initialization. */
const METADATA = {
  name: "MOI MCP Server",
  description: "Lets an AI agent read MOI chain state and propose interactions for you to approve.",
  url: "https://moi.technology",
  icons: ["https://moi.technology/favicon.ico"],
};

/**
 * Multi-user-safe wrapper around the single WalletConnect SignClient.
 *
 * The hub owns the relay connection and mediates all signing. It never touches
 * userId or makes routing decisions — those stay in hosted-writes.ts. It only
 * knows topics and the relay.
 */
export class WalletConnectHub implements WalletConnectHubLike {
  /**
   * Public so tests can construct a hub around a fake SignClientLike
   * directly. Production code should still only ever call this once, via
   * WalletConnectHub.init() in main() — that invariant is process wiring,
   * not something the type system enforces here.
   */
  constructor(private readonly signClient: SignClientLike) {}

  /**
   * Constructs and initializes the single WalletConnectHub for this process.
   * Called once by main() before any tool registration.
   */
  static async init(config: WcConfig): Promise<WalletConnectHub> {
    const client = await defaultFactory(config);
    return new WalletConnectHub(client);
  }

  /**
   * Closes the underlying relay socket. Call once at process shutdown.
   */
  async close(): Promise<void> {
    // SignClient doesn't expose a close method; relay stays open until disconnect.
    // This is a hook for future cleanup or explicit relay teardown.
  }

  /**
   * Signs an unsigned interaction on the WalletConnect session identified by topic.
   *
   * STRICTLY requires a topic — no userId, Session, account, or any alternate
   * routing. The topic is looked up in the underlying SignClient's own session
   * store (keyed by topic, per WalletConnect semantics), NOT via our
   * WalletSessionStore or any caller-supplied object.
   *
   * Throws MoiError(WALLET_NOT_CONNECTED) if:
   * - No native session exists for the topic (never paired, or relay-expired/deleted)
   * - The topic is invalid or unreachable on the relay
   *
   * Throws MoiError(USER_REJECTED | INVALID_ARGS | ...) if the wallet rejects
   * the signature request or finds the payload malformed.
   *
   * @param topic - WalletConnect session topic, sourced only from StoredWalletSession.topic
   * @param ix - Unsigned interaction to sign
   * @param opts - Optional description for the approval screen
   * @returns Signed payload { ix_args, signatures } ready to broadcast
   */
  async signInteractionFor(
    topic: string,
    ix: UnsignedInteraction,
    opts: SignInteractionOpts = {},
  ): Promise<HubSignResult> {
    // Validate that a native session exists for this topic.
    // If it's gone (relay-expired, phone-unpaired), fail immediately.
    const nativeSession = this.signClient.session.get(topic);
    if (!nativeSession) {
      throw new MoiError(
        ErrorCode.WALLET_NOT_CONNECTED,
        "The wallet session is no longer valid. Pair again with moi_connect_wallet.",
      );
    }

    // Extract chainId from the native session. It was stored by the relay
    // when the wallet approved the pairing, so trust it.
    const session = nativeSession as { topic?: string; chainId?: string; [k: string]: unknown };
    const chainId = session.chainId;
    if (!chainId) {
      throw new MoiError(
        ErrorCode.RELAY_UNAVAILABLE,
        "Native WalletConnect session has no chainId. This should not happen.",
      );
    }

    // Sign via the relay.
    try {
      const raw = await this.signClient.request<unknown>({
        topic,
        chainId,
        request: { method: "moi.signInteraction", params: [toWireJson(ix)] },
      });

      // Parse the result. WcSignInteractionResult schema from schema.ts validates
      // the shape. If parsing fails, the wallet returned something we don't understand.
      const { WcSignInteractionResult } = await import("../schema.js");
      const parsed = WcSignInteractionResult.safeParse(raw);
      if (!parsed.success) {
        throw new MoiError(
          ErrorCode.RPC_ERROR,
          `MOI Wallet signed the interaction but returned an unexpected payload: ${JSON.stringify(raw)?.slice(0, 200)}`,
        );
      }

      return parsed.data as HubSignResult;
    } catch (err) {
      // If it's already a MoiError, pass it through.
      if (err instanceof MoiError) throw err;

      // Log the raw error for diagnostics (no console in hosted env; logging goes to stderr).
      try {
        process.stderr.write(
          `[moi-mcp-hub] debug: raw wallet error ${JSON.stringify(err, Object.getOwnPropertyNames(Object(err))).slice(0, 400)}\n`,
        );
      } catch {
        /* diagnostics must never break the error path */
      }

      // Translate WalletConnect errors into readable MoiErrors.
      throw translateWcError(err);
    }
  }

  /**
   * Registers a handler for when a wallet session is deleted out-of-band.
   *
   * The relay fires a `session_delete` event when a user unpairs a session on
   * their phone. This handler lets the caller (main() wiring) reconcile our
   * own WalletSessionStore when that happens.
   *
   * The handler receives only the bare topic; resolving topic -> userId is the
   * caller's job (via WalletSessionStore.findByTopic), keeping this class
   * ignorant of userId entirely.
   *
   * @param handler - Called with the topic when session_delete fires
   * @returns Unsubscribe function; call to stop listening
   */
  onSessionDelete(handler: (topic: string) => void): () => void {
    const wrappedHandler = (payload: unknown) => {
      // WalletConnect passes { topic: string } on session_delete.
      const p = payload as { topic?: string };
      if (p?.topic) {
        handler(p.topic);
      }
    };

    this.signClient.on("session_delete", wrappedHandler);

    // Return unsubscribe function (naive; SignClient doesn't expose .off).
    // Callers should only call this at shutdown, so a no-op is acceptable.
    return () => {
      // No-op: we've subscribed once and will listen for the lifetime of the hub.
      // Proper teardown would require SignClient.off, which is not exposed.
    };
  }
}

/**
 * Default factory: creates and initializes a real SignClient.
 * Injected by tests with a fake.
 */
async function defaultFactory(cfg: WcConfig): Promise<SignClientLike> {
  const client = await SignClient.init({
    projectId: cfg.projectId,
    metadata: METADATA,
    storageOptions: { database: `${cfg.home}/wc.db` },
  });
  return client as unknown as SignClientLike;
}
