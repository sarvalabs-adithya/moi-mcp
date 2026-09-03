/**
 * Mandate execution: agent-signed TransferFrom under a cap-bearing Approve.
 *
 * Per the v2 contract binding, execution follows this order:
 *  1. resolve agent (getOrCreate) + owner address
 *  2. requireAgentFunding — refuse early if underfunded, no chain/ledger write
 *  3. buildTransferFrom (unsigned, ReadOnlySigner passed)
 *  4. assertWillSucceed (simulate) — refuse on failure, ledger untouched
 *  5. ledger.reserve(key, amount) — refuse MANDATE_NOT_FOUND/EXPIRED/EXCEEDED
 *  6. mandateSignerForUser → sign (agent-only key, server-held)
 *  7. provider.sendInteraction (broadcast)
 *  8a. success → ledger.commit(journalEntryId)
 *  8b. failure (sign or broadcast throws) → ledger.release(journalEntryId)
 *
 * This ensures: no spending against an unfunded agent, no broadcasting a doomed
 * interaction, no losing a cap reservation, and no leaked cap on sign/broadcast failure.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getConfig, log } from "../config.js";
import { toMcpError } from "../errors.js";
import { isMoiError, MoiError } from "../moi-error.js";
import { buildTransferFrom, type MandateSpendParams } from "../moi/mandates.js";
import { getProvider, getReadOnlySigner } from "../moi/provider.js";
import { getAsset, toBigInt } from "../moi/reads.js";
import { parseAmount, type UnsignedInteraction } from "../moi/ix-builder.js";
import { ErrorCode, type Network } from "../schema.js";
import type { AuthInfo } from "../auth/index.js";
import type { AgentKeyStore } from "../signing/agent-keys.js";
import { MandateLedger, type MandateKey } from "../mandates/ledger.js";
import { MIN_AGENT_FUNDING_KMOI } from "../mandates/funding.js";
import { mandateSignerForUser } from "../signing/mandate-signer.js";
import { signAndBroadcast } from "../signing/index.js";
import { assertWillSucceed, senderFor } from "./writes.js";

/**
 * Dependencies injected by registerMandateExecutor.
 */
export interface MandateExecuteDeps {
  store: { get(userId: string): Promise<{ address: string } | undefined> };
  ledger: MandateLedger;
  agentKeys: AgentKeyStore;
  provider: {
    sendInteraction(req: { ix_args: string; signatures: string }): Promise<{ hash: string }>;
    getPendingInteractionCount(id: string, keyId: number): Promise<number | bigint>;
  };
  dataDir: string;
  providerOptions(): { network: Network; rpcUrl?: string };
}

/**
 * Agent funding status, including shortfall and suggested remediation.
 * Never contains a signed interaction — only a report and remediation descriptor.
 */
export interface AgentFundingStatus {
  agentAddress: string;
  assetId: string;
  balance: bigint;
  required: bigint;
  sufficient: boolean;
  shortfall: bigint; // 0n when sufficient
}

export interface AgentFundingSuggestedAction {
  kind: "owner_phone_signed_transfer";
  from: string; // owner address
  to: string; // agentAddress
  assetId: string;
  amount: string; // decimal string == shortfall
  tool: "moi_transfer";
}

/**
 * Estimated transfer fuel, in base units (fuel price always 1 in v2 contract).
 * Measured via simulation; we do not hold an agent key capable of signing,
 * so we cannot pre-measure in the usual way.
 */
// Re-exported, not redefined. How much fuel an agent needs before it may spend
// is custody-relevant, and two copies drift the first time someone edits one.
export {
  TRANSFER_FROM_FUEL_ESTIMATE,
  FUEL_MARGIN_BPS,
  MIN_AGENT_FUNDING_KMOI,
} from "../mandates/funding.js";

/**
 * Funding check result: either funded and ready, or underfunded with remediation.
 */
export type FundingCheckResult =
  | { funded: true; status: AgentFundingStatus }
  | {
      funded: false;
      status: AgentFundingStatus;
      suggestedAction: AgentFundingSuggestedAction;
    };

/**
 * Outcome of a mandate execution attempt.
 */
export type MandateExecuteResult =
  | { status: "confirmed"; hash: string; remainingCap: string }
  | {
      status: "refused";
      reason:
        | "AGENT_UNDERFUNDED"
        | "SIMULATION_FAILED"
        | "MANDATE_NOT_FOUND"
        | "MANDATE_EXPIRED"
        | "MANDATE_EXCEEDED"
        | "SIGN_FAILED"
        | "BROADCAST_FAILED";
      detail: string;
      remainingCap?: string;
      fundingRequired?: AgentFundingSuggestedAction;
    };

/**
 * Read agent balance from the chain.
 */
async function readAgentBalance(
  provider: ReturnType<typeof getProvider>,
  agentAddress: string,
  assetId: string,
): Promise<bigint> {
  const { getAccount } = await import("../moi/reads.js");
  const state = await getAccount(provider, agentAddress);
  const held = state.balances.find((b) => b.assetId.toLowerCase() === assetId.toLowerCase());
  return toBigInt(held?.amount ?? 0);
}

/**
 * Check agent funding status (no side effects).
 */
export async function getAgentFundingStatus(
  provider: ReturnType<typeof getProvider>,
  agentAddress: string,
  assetId: string,
  required: bigint = MIN_AGENT_FUNDING_KMOI,
): Promise<AgentFundingStatus> {
  const balance = await readAgentBalance(provider, agentAddress, assetId);
  const shortfall = balance >= required ? 0n : required - balance;
  return { agentAddress, assetId, balance, required, sufficient: shortfall === 0n, shortfall };
}

/**
 * Check funding and return remediation if needed.
 */
async function requireAgentFunding(
  provider: ReturnType<typeof getProvider>,
  ownerAddress: string,
  agentAddress: string,
  assetId: string,
  required: bigint = MIN_AGENT_FUNDING_KMOI,
): Promise<FundingCheckResult> {
  const status = await getAgentFundingStatus(provider, agentAddress, assetId, required);
  if (status.sufficient)
    return { funded: true, status };
  return {
    funded: false,
    status,
    suggestedAction: {
      kind: "owner_phone_signed_transfer",
      from: ownerAddress,
      to: agentAddress,
      assetId,
      amount: status.shortfall.toString(),
      tool: "moi_transfer",
    },
  };
}

/**
 * Register moi_transfer_under_mandate tool.
 */
export function registerMandateExecutor(
  server: McpServer,
  deps: MandateExecuteDeps,
  auth: AuthInfo,
): void {
  const ExecuteInput = z.object({
    assetId: z.string().optional().describe("Asset ID. Defaults to KMOI."),
    beneficiary: z.string().describe("Recipient address (final on-chain recipient of this transfer)."),
    amount: z.string().describe("Transfer amount, as a decimal string (e.g., '10.5')."),
  });

  const RefusalOutput = z.object({
    status: z.literal("refused"),
    reason: z.enum([
      "AGENT_UNDERFUNDED",
      "SIMULATION_FAILED",
      "MANDATE_NOT_FOUND",
      "MANDATE_EXPIRED",
      "MANDATE_EXCEEDED",
      "SIGN_FAILED",
      "BROADCAST_FAILED",
    ]),
    detail: z.string(),
    remainingCap: z.string().optional(),
    fundingRequired: z
      .object({
        kind: z.literal("owner_phone_signed_transfer"),
        from: z.string(),
        to: z.string(),
        assetId: z.string(),
        amount: z.string(),
        tool: z.literal("moi_transfer"),
      })
      .optional(),
  });

  const ConfirmedOutput = z.object({
    status: z.literal("confirmed"),
    hash: z.string(),
    remainingCap: z.string(),
    // Present only when the transfer reached the chain but its journal write
    // failed; the cap stays counted, and this says the ledger is behind.
    ledgerWarning: z.string().optional(),
  });

  const ExecuteOutputShape = z.union([ConfirmedOutput, RefusalOutput]);

  server.registerTool(
    "moi_transfer_under_mandate",
    {
      title: "Transfer an asset under mandate authority",
      description:
        "Execute a transfer under a delegation mandate (Approve/TransferFrom). The server signs " +
        "with the agent key and broadcasts immediately — no wallet approval needed. The mandate " +
        "cap is enforced server-side before signing, and the ledger is updated atomically on success.",
      inputSchema: ExecuteInput.shape,
      outputSchema: ExecuteOutputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ assetId: suppliedAssetId, beneficiary, amount: amountStr }) => {
      try {
        const cfg = getConfig();
        const providerOptions = deps.providerOptions();

        // Resolve KMOI_ASSET_ID
        let assetId = suppliedAssetId;
        if (!assetId) {
          const { KMOI_ASSET_ID } = await import("js-moi-sdk");
          assetId = String(KMOI_ASSET_ID);
        }

        // PHASE 0: Resolve agent + owner address.
        const ownerSession = await deps.store.get(auth.userId);
        if (!ownerSession) {
          throw new MoiError(
            ErrorCode.WALLET_NOT_CONNECTED,
            "No MOI Wallet is paired. Call moi_connect_wallet and scan the QR code with MOI Wallet.",
          );
        }
        const ownerAddress = ownerSession.address;

        const agent = await deps.agentKeys.getOrCreate(auth.userId);
        const agentAddress = agent.address;

        // PHASE 1: Funding gate (cheap, no chain/ledger side effects).
        const provider = getProvider(providerOptions);
        const asset = await getAsset(provider, assetId);
        const amountRaw = parseAmount(amountStr, asset.dimension);

        const funding = await requireAgentFunding(provider, ownerAddress, agentAddress, assetId);
        if (!funding.funded) {
          const result: z.infer<typeof RefusalOutput> = {
            status: "refused",
            reason: "AGENT_UNDERFUNDED",
            detail: `Agent balance ${funding.status.balance} < required ${funding.status.required}`,
            fundingRequired: funding.suggestedAction,
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          };
        }

        // Mandate key (agent is the approved beneficiary in the ledger).
        const mandateKey: MandateKey = {
          userId: auth.userId,
          assetId,
          benefactor: ownerAddress,
          beneficiary: agentAddress,
        };

        // PHASE 2: Build unsigned (ReadOnlySigner, never invoked).
        const params: MandateSpendParams = {
          assetId,
          benefactor: ownerAddress,
          beneficiary, // actual recipient — distinct from mandateKey.beneficiary
          amount: amountRaw,
        };
        const sender = await senderFor(agentAddress);
        const ix: UnsignedInteraction = await buildTransferFrom(
          getReadOnlySigner(providerOptions),
          sender,
          params,
        );

        // PHASE 3: Simulate before reserving.
        try {
          await assertWillSucceed(ix);
        } catch (e) {
          const result: z.infer<typeof RefusalOutput> = {
            status: "refused",
            reason: "SIMULATION_FAILED",
            detail: String(e instanceof Error ? e.message : e),
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          };
        }

        // PHASE 4: Reserve (enforces cap/expiry, serialized per-key).
        let reservation: { journalEntryId: string; remainingAfter: bigint };
        try {
          reservation = await deps.ledger.reserve(mandateKey, amountRaw);
        } catch (e: any) {
          const reason: z.infer<typeof RefusalOutput>["reason"] =
            e?.code === ErrorCode.MANDATE_NOT_FOUND
              ? "MANDATE_NOT_FOUND"
              : e?.code === ErrorCode.MANDATE_EXPIRED
                ? "MANDATE_EXPIRED"
                : "MANDATE_EXCEEDED";
          const result: z.infer<typeof RefusalOutput> = {
            status: "refused",
            reason,
            detail: String(e instanceof Error ? e.message : e),
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          };
        }

        // PHASE 5+6: Sign (agent key) + broadcast.
        //
        // Only this narrow block may release the reservation. Once sendInteraction
        // returns a hash the transfer exists on chain, so a later failure (notably
        // the commit journal write) must never be reported as "nothing happened":
        // the caller would retry in good faith and spend the cap a second time for
        // real. Past this point we keep the reservation and return the hash.
        let hash: string;
        try {
          // Past this line a crash can no longer be read as "never sent", so the
          // reconciler will hold the cap rather than hand it back.
          await deps.ledger.markBroadcasting(reservation.journalEntryId);
          const mandateSigner = await mandateSignerForUser(deps.dataDir, auth.userId);
          hash = await signAndBroadcast(
            mandateSigner,
            deps.provider,
            ix,
            `Mandate transfer ${amountStr} ${asset.symbol || assetId} to ${beneficiary}`,
          );
        } catch (e) {
          // PHASE 8b: Release on sign/broadcast failure — nothing reached the chain.
          await deps.ledger.release(reservation.journalEntryId);

          const reason: z.infer<typeof RefusalOutput>["reason"] = String(e).includes("sign")
            ? "SIGN_FAILED"
            : "BROADCAST_FAILED";
          const result: z.infer<typeof RefusalOutput> = {
            status: "refused",
            reason,
            detail: String(e instanceof Error ? e.message : e),
            remainingCap: reservation.remainingAfter.toString(),
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          };
        }

        // PHASE 8a: Broadcast succeeded. Commit the spend. If the journal write
        // fails the money still moved, so we keep the reservation counted (fail
        // closed against the cap) and still hand back the hash.
        let committed = true;
        try {
          await deps.ledger.commit(reservation.journalEntryId, { ixHash: hash });
        } catch (e) {
          committed = false;
          log(
            "error",
            `mandate spend ${hash} broadcast but its journal commit failed: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }

        const result: z.infer<typeof ConfirmedOutput> = {
          status: "confirmed",
          hash,
          remainingCap: reservation.remainingAfter.toString(),
          ...(committed ? {} : { ledgerWarning: "spend broadcast but not journaled" }),
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (err) {
        if (isMoiError(err)) {
          const result: z.infer<typeof RefusalOutput> = {
            status: "refused",
            reason: "SIGN_FAILED",
            detail: err.message,
          };
          return {
            content: [{ type: "text" as const, text: err.message }],
            structuredContent: result,
          };
        }
        throw toMcpError(err);
      }
    },
  );
}
