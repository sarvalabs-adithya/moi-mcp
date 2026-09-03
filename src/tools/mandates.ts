/**
 * Mandate tools — grant delegated spend authority over an asset to an agent.
 *
 * Per the v2 contract, only two tools are registered here:
 *   1. moi_mandate_status — read-only ledger probe of an active mandate
 *   2. moi_grant_mandate — build an Approve, simulate, journal, return unsigned + ceremony stub
 *
 * NOT in scope: moi_transfer_under_mandate (the actual spend). That is a separate milestone.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getConfig } from "../config.js";
import { toMcpError } from "../errors.js";
import { isMoiError, MoiError } from "../moi-error.js";
import { parseAmount, type UnsignedInteraction } from "../moi/ix-builder.js";
import { getProvider, getReadOnlySigner, NETWORKS } from "../moi/provider.js";
import { getAsset } from "../moi/reads.js";
import { buildApprove } from "../moi/mandates.js";
import { ErrorCode, type Network } from "../schema.js";
import type { AuthInfo } from "../auth/index.js";
import type { WalletSessionStore } from "../wc/store.js";
import type { WriteJournal } from "../journal.js";
import { assertWillSucceed, senderFor, broadcastSigned } from "./write-core.js";
import type { WalletConnectHubLike } from "../wc/hub.js";
import type { AgentKeyStore } from "../signing/agent-keys.js";
import { MandateLedger, type MandateKey } from "../mandates/ledger.js";

/**
 * Dependencies injected by registerMandateTools.
 */
export interface MandateToolDeps {
  store: WalletSessionStore;
  /** Shared WalletConnect hub. Approve is owner-signed, so the grant is sent
   *  to the caller's own phone on their own session topic. */
  hub: WalletConnectHubLike;
  /** Kept for parity with the contract's dependency list; mandate journal
   *  writes go through `ledger`, which owns the journal internally. */
  journal: WriteJournal;
  agentKeys: AgentKeyStore;
  ledger: MandateLedger;
  providerOptions(): { network: Network; rpcUrl?: string };
}

/**
 * Schema input for moi_mandate_status.
 */
const MandateStatusInput = z.object({
  assetId: z.string().optional().describe("Asset ID. Defaults to KMOI."),
});

/**
 * Schema output for moi_mandate_status.
 */
const MandateStatusOutput = z.object({
  connected: z.boolean().describe("Whether the owner has a paired wallet."),
  agentAddress: z.string().optional().describe("Agent's participant ID, if provisioned."),
  cap: z.string().optional().describe("Mandate cap in base units."),
  spent: z.string().optional().describe("Amount already spent from the mandate."),
  remaining: z.string().optional().describe("Remaining spend authority (cap - spent)."),
  expiresAt: z.number().optional().describe("Unix timestamp when mandate expires."),
  active: z.boolean().describe("Whether the mandate is currently active."),
});

/**
 * Schema input for moi_grant_mandate.
 */
const GrantMandateInput = z.object({
  amount: z.string().describe("Mandate cap, as a decimal string (e.g., '100.5')."),
  expiresInSeconds: z
    .number()
    .int()
    .positive()
    .describe("How many seconds from now the mandate expires."),
  assetId: z.string().optional().describe("Asset ID. Defaults to KMOI."),
});

/**
 * Schema output for moi_grant_mandate.
 * Returns unsigned interaction awaiting owner approval via phone signature.
 * The journalEntryId is used to confirm/abandon the grant once the owner
 * approves or rejects on their wallet.
 */
const GrantMandateOutput = z.object({
  status: z.literal("active").describe("Owner approved on their phone and the Approve is on chain."),
  hash: z.string().describe("Interaction hash of the on-chain Approve."),
  agentAddress: z.string().describe("Agent's address (provisioned on first grant)."),
  cap: z.string().describe("Approved cap in base units."),
  expiresAt: z.number().describe("Unix expiry timestamp (now + expiresInSeconds)."),
  journalEntryId: z
    .string()
    .describe("Unique grant journal entry ID; pass to confirmMandateGrant() or abandonMandateGrant() after owner's wallet approval."),
});

const GRANT_MANDATE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/**
 * Register mandate tools onto an authenticated request's server.
 * Called only after deps.authenticate(req) succeeded (same pattern as registerWalletSurface).
 */
export function registerMandateTools(
  server: McpServer,
  deps: MandateToolDeps,
  auth: AuthInfo,
): void {
  /**
   * moi_mandate_status — read the ledger for the current mandate state.
   */
  server.registerTool(
    "moi_mandate_status",
    {
      title: "Get mandate status",
      description: "Check the current delegation mandate for an asset. Shows cap, spent, expiry, and active status.",
      inputSchema: MandateStatusInput.shape,
      outputSchema: MandateStatusOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ assetId: suppliedAssetId }) => {
      try {
        // Resolve KMOI_ASSET_ID
        let assetId = suppliedAssetId;
        if (!assetId) {
          const { KMOI_ASSET_ID } = await import("js-moi-sdk");
          assetId = String(KMOI_ASSET_ID);
        }

        // Check wallet connection (the owner/benefactor's paired session).
        const record = await deps.store.get(auth.userId);
        if (!record) {
          const structuredContent = { connected: false, active: false };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
            structuredContent,
          };
        }

        // The agent (beneficiary) is never created by this tool — only
        // moi_grant_mandate provisions one.
        const agentRecord = await deps.agentKeys.get(auth.userId);
        if (!agentRecord) {
          const structuredContent = { connected: true, active: false };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
            structuredContent,
          };
        }

        // Ledger, not chain, is the source of truth (no GetAllowance on MAS0).
        const key: MandateKey = {
          userId: auth.userId,
          assetId,
          benefactor: record.address,
          beneficiary: agentRecord.address,
        };
        const mandate = await deps.ledger.get(key);

        const structuredContent = {
          connected: true,
          agentAddress: agentRecord.address,
          ...(mandate.found
            ? {
                cap: mandate.cap.toString(),
                spent: mandate.spent.toString(),
                remaining: mandate.remaining.toString(),
                expiresAt: mandate.expiresAt,
              }
            : {}),
          active: mandate.active,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent,
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  /**
   * moi_grant_mandate — build an Approve interaction, simulate, journal (proposed state),
   * return unsigned + ceremony stub. Does NOT sign/broadcast yet.
   */
  server.registerTool(
    "moi_grant_mandate",
    {
      title: "Grant a delegation mandate",
      description:
        "Authorize a server-held agent to transfer up to a given amount of an asset on your behalf, " +
        "until a future expiry. Builds the interaction here and returns it unsigned — you approve " +
        "it on your phone, then the server broadcasts. Once you approve on your wallet and the server " +
        "receives confirmation, call confirmMandateGrant(journalEntryId) to activate the mandate.",
      inputSchema: GrantMandateInput.shape,
      outputSchema: GrantMandateOutput,
      annotations: GRANT_MANDATE_ANNOTATIONS,
    },
    async ({ amount: amountStr, expiresInSeconds, assetId: suppliedAssetId }) => {
      try {
        const cfg = getConfig();

        // Resolve KMOI_ASSET_ID
        let assetId = suppliedAssetId;
        if (!assetId) {
          const { KMOI_ASSET_ID } = await import("js-moi-sdk");
          assetId = String(KMOI_ASSET_ID);
        }

        // Guard 1: owner wallet connected.
        const record = await deps.store.get(auth.userId);
        if (!record) {
          throw new MoiError(
            ErrorCode.WALLET_NOT_CONNECTED,
            "No MOI Wallet is paired. Call moi_connect_wallet and scan the QR code with MOI Wallet.",
          );
        }

        // Guard 2: session network matches this server's configured network.
        const expectedCaip2 = NETWORKS[cfg.MOI_NETWORK].caip2;
        if (record.caip2 !== expectedCaip2) {
          throw new MoiError(
            ErrorCode.NETWORK_MISMATCH,
            `The paired wallet is on ${record.caip2} but this server is configured for ${cfg.MOI_NETWORK} (${expectedCaip2}).`,
            { sessionCaip2: record.caip2, expectedCaip2 },
          );
        }

        // Guard 3: provision (or reuse) the agent key. First grant creates it.
        const agentRecord = await deps.agentKeys.getOrCreate(auth.userId);
        const agentAddress = agentRecord.address;

        // Guard 4: get asset (validate it exists, get dimension for amount parsing).
        const provider = getProvider(deps.providerOptions());
        const asset = await getAsset(provider, assetId);

        // Guard 5: parse amount.
        const capRaw = parseAmount(amountStr, asset.dimension);

        // Guard 6: expiry must be in the future.
        const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
        if (expiresAt <= Math.floor(Date.now() / 1000)) {
          throw new MoiError(
            ErrorCode.INVALID_ARGS,
            `Expiry time must be in the future (now + ${expiresInSeconds}s, got ${expiresAt}).`,
          );
        }

        // Guard 7: cap must be positive.
        if (capRaw <= 0n) {
          throw new MoiError(ErrorCode.INVALID_ARGS, `Mandate cap must be positive, got ${amountStr}.`);
        }

        // Build the OWNER-signed Approve via module 1. `signer` here is
        // build-only (never invoked to sign) — same ReadOnlySigner pattern
        // writes.ts uses for buildMint.
        const sender = await senderFor(record.address);
        const unsignedIx: UnsignedInteraction = await buildApprove(
          getReadOnlySigner(deps.providerOptions()),
          sender,
          { assetId, beneficiary: agentAddress, amount: capRaw, expiresAt },
        );

        // Simulate before journaling — never journal a grant that would revert.
        await assertWillSucceed(
          unsignedIx,
          "Approve requires you to hold the asset (or be its manager) and the amount to fit the asset's dimension.",
        );

        // Journal via the ledger (module 4) — records as "proposed" state.
        // The grant becomes found/active only after the owner approves on their wallet
        // (confirmMandateGrant is called), preventing spending against unconfirmed grants.
        const grantResult = await deps.ledger.recordGrant(
          { userId: auth.userId, assetId, benefactor: record.address, beneficiary: agentAddress },
          capRaw,
          expiresAt,
        );

        // Send the Approve to the owner's own phone, on their own session
        // topic, and only activate the mandate once it is actually on chain.
        // A grant that is merely journaled authorizes nothing: get() gates on
        // the confirmed state, so a failure here leaves the mandate inactive.
        let hash: string;
        try {
          const { ix_args, signatures } = await deps.hub.signInteractionFor(record.topic, unsignedIx, {
            description: `Allow the agent to spend up to ${amountStr} until ${new Date(expiresAt * 1000).toISOString()}`,
          });
          hash = await broadcastSigned(ix_args, signatures);
        } catch (e) {
          await abandonMandateGrant(deps.ledger, grantResult.journalEntryId);
          throw e;
        }

        await confirmMandateGrant(deps.ledger, grantResult.journalEntryId);

        const structuredContent = {
          status: "active" as const,
          hash,
          agentAddress,
          cap: capRaw.toString(),
          expiresAt,
          journalEntryId: grantResult.journalEntryId,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent: structuredContent as Record<string, unknown>,
        };
      } catch (err) {
        if (isMoiError(err)) {
          return {
            content: [{ type: "text" as const, text: err.message }],
            structuredContent: { status: "error", code: err.code, message: err.message },
          };
        }
        throw toMcpError(err);
      }
    },
  );
}

/**
 * Activates a grant once the owner's Approve is on chain, moving its journal
 * entry from "proposed" to "confirmed". Until this runs the mandate is not
 * found or active, so nothing can be spent against it.
 *
 * Called by moi_grant_mandate after the phone signs and the broadcast lands.
 */
export async function confirmMandateGrant(ledger: MandateLedger, journalEntryId: string): Promise<void> {
  await ledger.commit(journalEntryId);
}

/**
 * Abandons a grant when the owner rejects it or the broadcast fails, moving
 * its journal entry to "orphaned" so the mandate never becomes active.
 */
export async function abandonMandateGrant(ledger: MandateLedger, journalEntryId: string): Promise<void> {
  await ledger.release(journalEntryId);
}
