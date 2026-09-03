/**
 * Multi-user write tools for the hosted MOI MCP server.
 *
 * Hosted-specific implementation of the write tools (moi_transfer, moi_create_asset,
 * moi_mint, moi_call_logic) that routes writes to the authenticated user's
 * WalletConnect session via the WalletConnectHub, then broadcasts the signed
 * interaction.
 *
 * Identity is always auth.userId. The session is looked up via deps.store.get(auth.userId),
 * and signed on that session's topic. No tool input schema may carry a topic, session id,
 * account override, or userId.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";

import { getConfig } from "../config.js";
import { messageOf } from "../errors.js";
import { interactionUrl } from "../moi/provider.js";
import type { AuthInfo } from "../auth/types.js";
import { isExpired } from "../wc/lifetime.js";
import {
  CallLogicInput,
  CreateAssetInput,
  MintInput,
  TransferInput,
} from "../schema.js";
import { MoiError } from "../moi-error.js";
import { ErrorCode } from "../schema.js";
import type { StoredWalletSession, WalletSessionStore } from "../wc/store.js";
import type { WalletConnectHubLike } from "../wc/hub.js";
import type { WriteJournal } from "../journal.js";
import {
  WriteOutputShape,
  asWriteResult,
  broadcastSigned,
  kmoiBalance,
  ok,
  prepareCreateAsset,
  prepareLogicInvoke,
  prepareMint,
  prepareTransfer,
  viewLogicCall,
} from "./write-core.js";

/**
 * Dependencies for hosted write tools.
 */
export interface HostedWriteDeps {
  store: WalletSessionStore;
  hub: WalletConnectHubLike;
  journal: WriteJournal;
}

/**
 * Record a signed-but-not-broadcast (or never-signed) attempt as failed once
 * we know it will not complete in this request. `wasSigned` picks the state:
 * once the wallet has produced a signature, a broadcast failure strands an
 * approved interaction ("orphaned" — exactly the mid-restart gap
 * reconcileOnBoot exists to close), whereas a failure before that point (the
 * user rejected on their phone, the wallet timed out, ...) never left the
 * user on the hook for anything, so it is just "failed". Journal writes are
 * best-effort: a journal I/O error must never mask the real tool error.
 */
async function markUnwound(
  journal: WriteJournal,
  id: string,
  wasSigned: boolean,
  err: unknown,
): Promise<void> {
  try {
    await journal.update(id, wasSigned ? "orphaned" : "failed", { detail: messageOf(err) });
  } catch {
    /* best-effort audit trail; never let this hide the original error */
  }
}

/**
 * Network-only pre-flight check against our own store record.
 * Expiry/liveness is NOT checked here — it is enforced by
 * WalletConnectHub.signInteractionFor via the native SignClient
 * session store, because StoredWalletSession does not carry
 * a first-class expiry/peer field.
 */
function assertNetworkMatches(stored: StoredWalletSession, expectedNetwork?: string): void {
  if (expectedNetwork && stored.caip2 !== expectedNetwork) {
    throw new MoiError("NETWORK_MISMATCH", `Wallet is on ${stored.caip2}, expected ${expectedNetwork}`);
  }
}

/**
 * Load and validate the user's wallet session from the store.
 */
async function loadSession(
  deps: HostedWriteDeps,
  auth: AuthInfo,
  expectedNetwork?: string,
): Promise<StoredWalletSession> {
  const stored = await deps.store.get(auth.userId);
  if (!stored) {
    throw new MoiError(ErrorCode.WALLET_NOT_CONNECTED, "No wallet paired for this account.");
  }
  if (isExpired(stored)) {
    await deps.store.delete(auth.userId);
    throw new MoiError(
      ErrorCode.WALLET_NOT_CONNECTED,
      "The wallet pairing has expired. Call moi_connect_wallet to pair again.",
    );
  }
  assertNetworkMatches(stored, expectedNetwork);
  return stored; // hub.signInteractionFor(stored.topic, ...) validates liveness
}

/**
 * A "just this once" pairing has done its one job. Forget it now, before the
 * result is even returned, so nothing can reuse it. The relay teardown is best
 * effort: the server-side deletion is the guarantee, the phone's list is
 * cosmetic.
 */
async function afterSignedUse(deps: HostedWriteDeps, session: StoredWalletSession): Promise<void> {
  if (session.mode !== "once") return;
  await deps.store.delete(session.userId);
  try {
    await deps.hub.disconnect(session.topic);
  } catch {
    // see above
  }
}

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/**
 * Register hosted write tools on the given server.
 *
 * Called only when auth is defined (within the auth-gated branch).
 */
export function registerHostedWrites(
  server: McpServer,
  deps: HostedWriteDeps,
  auth: AuthInfo | null,
): void {
  // Registered even when the caller is anonymous, so the tools appear in
  // tools/list and a model knows they exist. Hiding them looked safer but was
  // worse: an unlisted tool is never called, so the 401 that prompts sign-in
  // never fires, and the user is told this server is read-only. Calls are
  // still gated — handleMcp answers 401 for these names before a handler runs,
  // and requireAuth() below is the belt to that braces.
  const requireAuth = (): AuthInfo => {
    if (!auth) {
      throw new MoiError(
        ErrorCode.WALLET_NOT_CONNECTED,
        "Sign in to this connector before proposing a transaction.",
      );
    }
    return auth;
  };
  server.registerTool(
    "moi_transfer",
    {
      title: "Transfer a MOI asset",
      description:
        "Propose a transfer of a MOI asset from the user's paired wallet; nothing moves until they tap Send on their phone. The balance is checked first." +
        " BEFORE calling this, state exactly what will happen in one sentence, with the amount, the asset symbol, and the full recipient address, and get the user's explicit yes. " +
        "The phone shows raw operation details, not that sentence, so the chat is where the user reads what they are approving. " +
        "Approval can take a few minutes; the call waits for it. Returns the interaction hash once broadcast, or a reason it was refused.",
      inputSchema: TransferInput.shape,
      outputSchema: WriteOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ to, assetId, amount, memo }) => {
      const id = randomUUID();
      let proposed = false;
      let signed = false;
      try {
        const cfg = getConfig();
        const session = await loadSession(deps, requireAuth());

        const prepared = await prepareTransfer(session.address, { to, assetId, amount, memo });

        await deps.journal.append({ id, userId: requireAuth().userId, kind: "transfer", state: "proposed" });
        proposed = true;

        const { ix_args, signatures } = await deps.hub.signInteractionFor(session.topic, prepared.ix, {
          description: prepared.description,
        });
        await deps.journal.update(id, "signed");
        signed = true;

        const hash = await broadcastSigned(ix_args, signatures);
        await afterSignedUse(deps, session);
        await deps.journal.update(id, "broadcast", { ixHash: hash });

        return ok({
          status: "sent",
          summary: prepared.description,
          hash,
          explorerUrl: interactionUrl(cfg.MOI_NETWORK, hash, cfg.MOI_EXPLORER_URL),
        });
      } catch (err) {
        if (proposed) await markUnwound(deps.journal, id, signed, err);
        return ok(asWriteResult(err));
      }
    },
  );

  server.registerTool(
    "moi_create_asset",
    {
      title: "Create a MOI asset",
      description:
        "Propose creating a new MOI asset owned by the user's paired wallet; nothing happens until they tap Send on their phone. Funds the asset's storage automatically." +
        " BEFORE calling this, state exactly what will happen in one sentence, with the amount, the asset symbol, and the full recipient address, and get the user's explicit yes. " +
        "The phone shows raw operation details, not that sentence, so the chat is where the user reads what they are approving. " +
        "Approval can take a few minutes; the call waits for it. Returns the interaction hash once broadcast, or a reason it was refused.",
      inputSchema: CreateAssetInput.shape,
      outputSchema: WriteOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ symbol, supply, dimension, standard, isStateful, isFungible, storageFund }) => {
      const id = randomUUID();
      let proposed = false;
      let signed = false;
      try {
        const cfg = getConfig();
        const session = await loadSession(deps, requireAuth());

        const balance = await kmoiBalance(session.address);
        const prepared = await prepareCreateAsset(session.address, {
          symbol,
          supply,
          dimension,
          standard,
          isStateful,
          isFungible,
          storageFund,
          balance,
        });

        await deps.journal.append({ id, userId: requireAuth().userId, kind: "create_asset", state: "proposed" });
        proposed = true;

        const { ix_args, signatures } = await deps.hub.signInteractionFor(session.topic, prepared.ix, {
          description: prepared.description,
        });
        await deps.journal.update(id, "signed");
        signed = true;

        const hash = await broadcastSigned(ix_args, signatures);
        await afterSignedUse(deps, session);
        await deps.journal.update(id, "broadcast", { ixHash: hash });

        return ok({
          status: "sent",
          summary: prepared.description,
          hash,
          explorerUrl: interactionUrl(cfg.MOI_NETWORK, hash, cfg.MOI_EXPLORER_URL),
        });
      } catch (err) {
        if (proposed) await markUnwound(deps.journal, id, signed, err);
        return ok(asWriteResult(err));
      }
    },
  );

  server.registerTool(
    "moi_mint",
    {
      title: "Mint tokens of a MOI asset",
      description:
        "Propose minting more of an asset the user's paired wallet manages; nothing happens until they tap Send on their phone." +
        " BEFORE calling this, state exactly what will happen in one sentence, with the amount, the asset symbol, and the full recipient address, and get the user's explicit yes. " +
        "The phone shows raw operation details, not that sentence, so the chat is where the user reads what they are approving. " +
        "Approval can take a few minutes; the call waits for it. Returns the interaction hash once broadcast, or a reason it was refused.",
      inputSchema: MintInput.shape,
      outputSchema: WriteOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ assetId, amount, to }) => {
      const id = randomUUID();
      let proposed = false;
      let signed = false;
      try {
        const cfg = getConfig();
        const session = await loadSession(deps, requireAuth());

        const prepared = await prepareMint(session.address, { assetId, amount, to });

        await deps.journal.append({ id, userId: requireAuth().userId, kind: "mint", state: "proposed" });
        proposed = true;

        const { ix_args, signatures } = await deps.hub.signInteractionFor(session.topic, prepared.ix, {
          description: prepared.description,
        });
        await deps.journal.update(id, "signed");
        signed = true;

        const hash = await broadcastSigned(ix_args, signatures);
        await afterSignedUse(deps, session);
        await deps.journal.update(id, "broadcast", { ixHash: hash });

        return ok({
          status: "sent",
          summary: prepared.description,
          hash,
          explorerUrl: interactionUrl(cfg.MOI_NETWORK, hash, cfg.MOI_EXPLORER_URL),
        });
      } catch (err) {
        if (proposed) await markUnwound(deps.journal, id, signed, err);
        return ok(asWriteResult(err));
      }
    },
  );

  server.registerTool(
    "moi_call_logic",
    {
      title: "Call a MOI logic routine",
      description:
        "Call a routine on a MOI logic. kind=view reads and needs no wallet; kind=invoke changes state and nothing happens until the user taps Send on their phone." +
        " BEFORE calling this, state exactly what will happen in one sentence, with the amount, the asset symbol, and the full recipient address, and get the user's explicit yes. " +
        "The phone shows raw operation details, not that sentence, so the chat is where the user reads what they are approving. " +
        "Approval can take a few minutes; the call waits for it. Returns the interaction hash once broadcast, or a reason it was refused.",
      inputSchema: CallLogicInput.shape,
      annotations: { ...WRITE_ANNOTATIONS, readOnlyHint: false },
    },
    async ({ logicId, routine, args, kind }) => {
      // A view runs against the node directly — no wallet, no approval, no
      // signed interaction, and so nothing for the journal to track.
      if (kind === "view") {
        try {
          const value = await viewLogicCall({ logicId, routine, args, kind: "view" });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
            structuredContent: value,
          };
        } catch (err) {
          return ok(asWriteResult(err));
        }
      }

      const id = randomUUID();
      let proposed = false;
      let signed = false;
      try {
        const cfg = getConfig();
        const session = await loadSession(deps, requireAuth());

        const prepared = await prepareLogicInvoke(session.address, { logicId, routine, args });

        await deps.journal.append({ id, userId: requireAuth().userId, kind: "call_logic", state: "proposed" });
        proposed = true;

        const { ix_args, signatures } = await deps.hub.signInteractionFor(session.topic, prepared.ix, {
          description: prepared.description,
        });
        await deps.journal.update(id, "signed");
        signed = true;

        const hash = await broadcastSigned(ix_args, signatures);
        await afterSignedUse(deps, session);
        await deps.journal.update(id, "broadcast", { ixHash: hash });

        return ok({
          status: "sent",
          summary: prepared.description,
          hash,
          explorerUrl: interactionUrl(cfg.MOI_NETWORK, hash, cfg.MOI_EXPLORER_URL),
        });
      } catch (err) {
        if (proposed) await markUnwound(deps.journal, id, signed, err);
        return ok(asWriteResult(err));
      }
    },
  );
}
