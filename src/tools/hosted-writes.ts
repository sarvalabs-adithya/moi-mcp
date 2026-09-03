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

import { getConfig } from "../config.js";
import { interactionUrl } from "../moi/provider.js";
import type { AuthInfo } from "../auth/types.js";
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
  assertNetworkMatches(stored, expectedNetwork);
  return stored; // hub.signInteractionFor(stored.topic, ...) validates liveness
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
export function registerHostedWrites(server: McpServer, deps: HostedWriteDeps, auth: AuthInfo): void {
  server.registerTool(
    "moi_transfer",
    {
      title: "Transfer a MOI asset",
      description:
        "Propose a transfer of a MOI native asset. Builds the interaction here and sends it to " +
        "MOI Wallet on your phone — nothing moves until you tap Send there. The balance is " +
        "checked first. Returns the interaction hash once broadcast.",
      inputSchema: TransferInput.shape,
      outputSchema: WriteOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ to, assetId, amount, memo }) => {
      try {
        const cfg = getConfig();
        const session = await loadSession(deps, auth);

        const prepared = await prepareTransfer(session.address, { to, assetId, amount, memo });

        const { ix_args, signatures } = await deps.hub.signInteractionFor(session.topic, prepared.ix, {
          description: prepared.description,
        });
        const hash = await broadcastSigned(ix_args, signatures);

        return ok({
          status: "sent",
          hash,
          explorerUrl: interactionUrl(cfg.MOI_NETWORK, hash, cfg.MOI_EXPLORER_URL),
        });
      } catch (err) {
        return ok(asWriteResult(err));
      }
    },
  );

  server.registerTool(
    "moi_create_asset",
    {
      title: "Create a MOI asset",
      description:
        "Propose creating a new MOI native asset (a token). `supply` sets the MAXIMUM supply — " +
        "it does not mint anything, so circulating supply starts at 0 and you will hold none " +
        "until you call moi_mint. `dimension` is the number of decimal places; `standard` is " +
        "MAS0, MAS1, MAS2 or MASX. Storage funding is handled automatically. Sent to MOI Wallet " +
        "for approval on your phone.",
      inputSchema: CreateAssetInput.shape,
      outputSchema: WriteOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ symbol, supply, dimension, standard, isStateful, isFungible, storageFund }) => {
      try {
        const cfg = getConfig();
        const session = await loadSession(deps, auth);

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

        const { ix_args, signatures } = await deps.hub.signInteractionFor(session.topic, prepared.ix, {
          description: prepared.description,
        });
        const hash = await broadcastSigned(ix_args, signatures);

        return ok({
          status: "sent",
          hash,
          explorerUrl: interactionUrl(cfg.MOI_NETWORK, hash, cfg.MOI_EXPLORER_URL),
        });
      } catch (err) {
        return ok(asWriteResult(err));
      }
    },
  );

  server.registerTool(
    "moi_mint",
    {
      title: "Mint tokens of a MOI asset",
      description:
        "Mint tokens of an asset you manage, to yourself or another account. Creating an asset " +
        "sets a maximum supply but mints nothing — until you mint, circulating supply is 0, you " +
        "hold none, and the asset does not appear in a wallet. Sent to MOI Wallet for approval.",
      inputSchema: MintInput.shape,
      outputSchema: WriteOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ assetId, amount, to }) => {
      try {
        const cfg = getConfig();
        const session = await loadSession(deps, auth);

        const prepared = await prepareMint(session.address, { assetId, amount, to });

        const { ix_args, signatures } = await deps.hub.signInteractionFor(session.topic, prepared.ix, {
          description: prepared.description,
        });
        const hash = await broadcastSigned(ix_args, signatures);

        return ok({
          status: "sent",
          hash,
          explorerUrl: interactionUrl(cfg.MOI_NETWORK, hash, cfg.MOI_EXPLORER_URL),
        });
      } catch (err) {
        return ok(asWriteResult(err));
      }
    },
  );

  server.registerTool(
    "moi_call_logic",
    {
      title: "Call a MOI logic routine",
      description:
        "Call a routine on a deployed MOI logic. kind:'view' reads the result immediately and " +
        "needs no wallet. kind:'invoke' changes state and is sent to MOI Wallet for approval. " +
        "Call moi_get_logic first to learn the routine names and argument order.",
      inputSchema: CallLogicInput.shape,
      annotations: { ...WRITE_ANNOTATIONS, readOnlyHint: false },
    },
    async ({ logicId, routine, args, kind }) => {
      try {
        const cfg = getConfig();

        // A view runs against the node directly — no wallet, no approval, and
        // no wallet-client construction either.
        if (kind === "view") {
          const value = await viewLogicCall({ logicId, routine, args, kind: "view" });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
            structuredContent: value,
          };
        }

        const session = await loadSession(deps, auth);

        const prepared = await prepareLogicInvoke(session.address, { logicId, routine, args });

        const { ix_args, signatures } = await deps.hub.signInteractionFor(session.topic, prepared.ix, {
          description: prepared.description,
        });
        const hash = await broadcastSigned(ix_args, signatures);

        return ok({
          status: "sent",
          hash,
          explorerUrl: interactionUrl(cfg.MOI_NETWORK, hash, cfg.MOI_EXPLORER_URL),
        });
      } catch (err) {
        return ok(asWriteResult(err));
      }
    },
  );
}
