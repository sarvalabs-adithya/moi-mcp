/**
 * Agent funding check — read-only, no key access, no signing.
 *
 * This module reports whether an agent account has sufficient balance to pay
 * for a mandate execution. If not, it returns a structured suggestion for the
 * owner to fund the agent via a phone-signed moi_transfer interaction.
 *
 * No wallet, no signing, no spending: the only code path is read-only chain
 * queries (getTDU) and a plain-data handoff. The owner must independently
 * authorize and sign a transfer — that happens entirely inside the v1 phone-sign
 * write path, outside this module.
 */

import type { JsonRpcProvider } from "js-moi-sdk";
import { KMOI_ASSET_ID } from "js-moi-sdk";

import { MoiError } from "../moi-error.js";
import { ErrorCode } from "../schema.js";
import { toBigInt } from "../moi/reads.js";

/**
 * Measured cost of a mandate spend (ASSET_INVOKE with transferFrom).
 * Empirically observed on voyage devnet; may vary by network/node load.
 */
export const TRANSFER_FROM_FUEL_ESTIMATE = 300n;

/**
 * Safety margin applied to the fuel estimate (basis points).
 * 1.5x = 15000 bps. Stored as integer to avoid floating point and maintain
 * bigint-safe arithmetic.
 */
export const FUEL_MARGIN_BPS = 15000n;

/**
 * Minimum agent funding in base units (smallest denomination).
 * Calculated as ceil(TRANSFER_FROM_FUEL_ESTIMATE * (1 + FUEL_MARGIN_BPS / 100000)).
 * 300 * 1.5 = 450 KMOI base units.
 */
export const MIN_AGENT_FUNDING_KMOI = 450n;

/**
 * The native MOI asset id (KMOI), re-exported for convenience.
 */
export const KMOI_ASSET_ID_CONST = String(KMOI_ASSET_ID);

/**
 * Current funding status of an agent account.
 */
export interface AgentFundingStatus {
  /** Agent's on-chain address. */
  agentAddress: string;
  /** Asset id (typically KMOI). */
  assetId: string;
  /** Current balance in base units. */
  balance: bigint;
  /** Required balance threshold. */
  required: bigint;
  /** True when balance >= required. */
  sufficient: boolean;
  /** Shortfall amount, 0n when sufficient. */
  shortfall: bigint;
}

/**
 * Result of a funding requirement check.
 * Either funding is sufficient, or it returns a suggestion for owner-signed transfer.
 */
export type FundingCheckResult =
  | {
      funded: true;
      status: AgentFundingStatus;
    }
  | {
      funded: false;
      status: AgentFundingStatus;
      /**
       * Structured hand-off to the owner: "you must sign and broadcast a transfer
       * with these exact details." This is a REPORT only — it contains no signed
       * interaction, no secrets, no code path to spending.
       *
       * The owner must independently invoke moi_transfer with these parameters.
       * Authorization happens entirely in the v1 phone-sign write path; this
       * module never touches the owner's key.
       */
      suggestedAction: {
        /** Literal action kind, for routing. */
        kind: "owner_phone_signed_transfer";
        /** Owner address (the key holder). */
        from: string;
        /** Agent address (the receiver). */
        to: string;
        /** Asset id to send. */
        assetId: string;
        /** Decimal string representation of the shortfall amount. */
        amount: string;
        /** Tool name to invoke for this action. */
        tool: "moi_transfer";
      };
    };

/**
 * Queries an agent's balance for a specific asset and returns funding status.
 * Never throws — returns found:false if the asset is not in the account's TDU.
 *
 * @param provider — JSON-RPC provider bound to the network.
 * @param agentAddress — Agent's on-chain participant id.
 * @param required — Funding threshold (defaults to MIN_AGENT_FUNDING_KMOI).
 * @param assetId — Asset to check (defaults to KMOI).
 * @returns AgentFundingStatus with balance, required, and shortfall.
 */
export async function getAgentFundingStatus(
  provider: JsonRpcProvider,
  agentAddress: string,
  required: bigint = MIN_AGENT_FUNDING_KMOI,
  assetId: string = KMOI_ASSET_ID_CONST,
): Promise<AgentFundingStatus> {
  let balance = 0n;

  try {
    // Fetch the account's holdings across all assets.
    const tdu = (await provider.getTDU(agentAddress)) as unknown as Array<Record<string, unknown>>;
    if (tdu && Array.isArray(tdu)) {
      for (const entry of tdu) {
        const entryAssetId = String(entry["asset_id"] ?? entry["token_id"] ?? "");
        // Match by case-insensitive hex comparison.
        if (entryAssetId.toLowerCase() === assetId.toLowerCase()) {
          balance = toBigInt(entry["amount"]);
          break;
        }
      }
    }
  } catch (err) {
    // On RPC failure, report a safe (zero) balance and let the gate refuse.
    // The error will be logged by the calling tool.
    balance = 0n;
  }

  const shortfall = balance >= required ? 0n : required - balance;
  return {
    agentAddress,
    assetId,
    balance,
    required,
    sufficient: shortfall === 0n,
    shortfall,
  };
}

/**
 * Checks whether an agent is sufficiently funded, and if not, returns
 * a structured suggestion for owner-signed transfer.
 *
 * @param provider — JSON-RPC provider.
 * @param ownerAddress — Owner's on-chain participant id (key holder).
 * @param agentAddress — Agent's on-chain participant id.
 * @param required — Funding threshold (defaults to MIN_AGENT_FUNDING_KMOI).
 * @returns FundingCheckResult: either {funded: true} or {funded: false, suggestedAction}.
 */
export async function requireAgentFunding(
  provider: JsonRpcProvider,
  ownerAddress: string,
  agentAddress: string,
  required: bigint = MIN_AGENT_FUNDING_KMOI,
): Promise<FundingCheckResult> {
  const status = await getAgentFundingStatus(provider, agentAddress, required, KMOI_ASSET_ID_CONST);

  if (status.sufficient) {
    return { funded: true, status };
  }

  return {
    funded: false,
    status,
    suggestedAction: {
      kind: "owner_phone_signed_transfer",
      from: ownerAddress,
      to: agentAddress,
      assetId: status.assetId,
      // Convert shortfall to decimal string for RPC.
      amount: status.shortfall.toString(),
      tool: "moi_transfer",
    },
  };
}
