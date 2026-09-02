/**
 * Mandate builders — OWNER-signed Approve/Revoke and AGENT-signed TransferFrom.
 *
 * Follows buildMint's pattern exactly: no MCP imports, pure interaction-building
 * library. Each builder delegates to MAS0AssetLogic and extracts ctx.payload +
 * ctx.participants from the SDK directly, never hand-reconstructing.
 */

import { OpType } from "js-moi-sdk";
import { MoiError } from "../moi-error.js";
import { ErrorCode } from "../schema.js";
import {
  type BuildOptions,
  type SenderInfo,
  type UnsignedInteraction,
  DEFAULT_FUEL_PRICE,
  DEFAULT_FUEL_LIMIT,
} from "./ix-builder.js";

export interface MandateGrantParams {
  assetId: string;
  beneficiary: string;
  amount: bigint;
  expiresAt: number;
}

export interface MandateRevokeParams {
  assetId: string;
  beneficiary: string;
}

export interface MandateSpendParams {
  assetId: string;
  benefactor: string;
  beneficiary: string;
  amount: bigint;
}

export interface MandateProbeResult {
  probed: boolean;
  likelyActive: boolean | "unknown";
  detail?: string;
}

function buildBase(sender: SenderInfo, options: BuildOptions): Omit<UnsignedInteraction, "ix_operations"> {
  return {
    sender: { id: sender.id, sequence: sender.sequence, key_id: sender.keyId ?? 0 },
    fuel_price: options.fuelPrice ?? DEFAULT_FUEL_PRICE,
    fuel_limit: options.fuelLimit ?? DEFAULT_FUEL_LIMIT,
  };
}

/**
 * Build an Approve interaction (OWNER-signed).
 * Grants a beneficiary (agent) the authority to spend up to `amount` of the asset
 * until `expiresAt`.
 */
export async function buildApprove(
  signer: unknown,
  sender: SenderInfo,
  params: MandateGrantParams,
  options: BuildOptions = {},
): Promise<UnsignedInteraction> {
  if (params.amount <= 0n) {
    throw new MoiError(ErrorCode.INVALID_ARGS, "Mandate amount must be > 0", { amount: params.amount.toString() });
  }
  if (params.expiresAt <= Math.floor(Date.now() / 1000)) {
    throw new MoiError(
      ErrorCode.INVALID_ARGS,
      `Mandate expiry (${params.expiresAt}) must be in the future`,
      { expiresAt: params.expiresAt },
    );
  }

  const { MAS0AssetLogic } = await import("js-moi-sdk");
  // SDK accepts number|bigint; match buildTransfer's logic: coerce within safe range
  const amount =
    params.amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(params.amount) : params.amount;

  let payload: Record<string, unknown> | undefined;
  let participants: Array<{ id: string; lock_type: number }> | undefined;
  try {
    const logic = new MAS0AssetLogic(params.assetId, signer as never) as unknown as {
      approve: (
        beneficiary: string,
        amount: number | bigint,
        expiresAt: number,
      ) => { ctx?: { payload?: Record<string, unknown>; participants?: Array<{ id: string; lock_type: number }> } };
    };
    const ctx = logic.approve(params.beneficiary, amount, params.expiresAt).ctx;
    payload = ctx?.payload;
    participants = ctx?.participants;
  } catch (err) {
    throw new MoiError(
      ErrorCode.INVALID_ARGS,
      `Could not build an approve for ${params.assetId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!payload) {
    throw new MoiError(ErrorCode.INVALID_ARGS, `Could not encode an approve for ${params.assetId}.`);
  }

  return {
    ...buildBase(sender, options),
    ix_operations: [
      {
        type: OpType.ASSET_INVOKE,
        payload: { ...payload, calldata: String(payload["calldata"] ?? "").replace(/^0x/, "") },
      },
    ],
    participants: participants ?? [],
  };
}

/**
 * Build a Revoke interaction (OWNER-signed).
 * Revokes a beneficiary's approval to spend the asset.
 */
export async function buildRevoke(
  signer: unknown,
  sender: SenderInfo,
  params: MandateRevokeParams,
  options: BuildOptions = {},
): Promise<UnsignedInteraction> {
  const { MAS0AssetLogic } = await import("js-moi-sdk");

  let payload: Record<string, unknown> | undefined;
  let participants: Array<{ id: string; lock_type: number }> | undefined;
  try {
    const logic = new MAS0AssetLogic(params.assetId, signer as never) as unknown as {
      revoke: (beneficiary: string) => { ctx?: { payload?: Record<string, unknown>; participants?: Array<{ id: string; lock_type: number }> } };
    };
    const ctx = logic.revoke(params.beneficiary).ctx;
    payload = ctx?.payload;
    participants = ctx?.participants;
  } catch (err) {
    throw new MoiError(
      ErrorCode.INVALID_ARGS,
      `Could not build a revoke for ${params.assetId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!payload) {
    throw new MoiError(ErrorCode.INVALID_ARGS, `Could not encode a revoke for ${params.assetId}.`);
  }

  return {
    ...buildBase(sender, options),
    ix_operations: [
      {
        type: OpType.ASSET_INVOKE,
        payload: { ...payload, calldata: String(payload["calldata"] ?? "").replace(/^0x/, "") },
      },
    ],
    participants: participants ?? [],
  };
}

/**
 * Build a TransferFrom interaction (AGENT-signed).
 * An approved agent spends up to its mandate cap, transferring from benefactor to beneficiary.
 */
export async function buildTransferFrom(
  signer: unknown,
  sender: SenderInfo,
  params: MandateSpendParams,
  options: BuildOptions = {},
): Promise<UnsignedInteraction> {
  if (params.amount < 0n) {
    throw new MoiError(ErrorCode.INVALID_ARGS, "Transfer amount must be >= 0", { amount: params.amount.toString() });
  }

  const { MAS0AssetLogic } = await import("js-moi-sdk");
  const amount =
    params.amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(params.amount) : params.amount;

  let payload: Record<string, unknown> | undefined;
  let participants: Array<{ id: string; lock_type: number }> | undefined;
  try {
    const logic = new MAS0AssetLogic(params.assetId, signer as never) as unknown as {
      transferFrom: (
        benefactor: string,
        beneficiary: string,
        amount: number | bigint,
      ) => { ctx?: { payload?: Record<string, unknown>; participants?: Array<{ id: string; lock_type: number }> } };
    };
    const ctx = logic.transferFrom(params.benefactor, params.beneficiary, amount).ctx;
    payload = ctx?.payload;
    participants = ctx?.participants;
  } catch (err) {
    throw new MoiError(
      ErrorCode.INVALID_ARGS,
      `Could not build a transferFrom for ${params.assetId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!payload) {
    throw new MoiError(ErrorCode.INVALID_ARGS, `Could not encode a transferFrom for ${params.assetId}.`);
  }

  return {
    ...buildBase(sender, options),
    ix_operations: [
      {
        type: OpType.ASSET_INVOKE,
        payload: { ...payload, calldata: String(payload["calldata"] ?? "").replace(/^0x/, "") },
      },
    ],
    participants: participants ?? [],
  };
}

/**
 * Dry-run a TransferFrom with amount 0 to probe if a mandate is likely active.
 *
 * NOT authoritative — no GetAllowance routine exists on MAS0. This is the only
 * chain signal available; exists for diagnostics/reconciliation only.
 * moi_mandate_status reads the ledger, never this.
 */
export async function probeMandate(
  caller: { call(ix: unknown): Promise<unknown> },
  sender: SenderInfo,
  params: { assetId: string; benefactor: string; beneficiary: string },
): Promise<MandateProbeResult> {
  try {
    // Create a minimal mock signer for building only — never invoked
    const mockSigner = {
      getIdentifier: async () => ({ toHex: () => sender.id }),
      getKeyId: async () => sender.keyId ?? 0,
      getNonce: async () => sender.sequence,
      sign: async () => new Uint8Array(0),
      signInteraction: async () => ({ ix_args: "", signatures: "" }),
    } as never;

    // Build a zero-amount TransferFrom to test the mandate without moving funds
    const ix = await buildTransferFrom(
      mockSigner,
      sender,
      { assetId: params.assetId, benefactor: params.benefactor, beneficiary: params.beneficiary, amount: 0n },
    );

    try {
      const response = (await caller.call(ix)) as { receipt?: Record<string, unknown> };
      const receipt = response?.receipt ?? {};
      const status = Number(BigInt(String(receipt["status"] ?? 0)));

      if (status === 0) {
        return { probed: true, likelyActive: true };
      }

      return { probed: true, likelyActive: false, detail: `status ${status}` };
    } catch (rpcErr) {
      return {
        probed: true,
        likelyActive: "unknown",
        detail: rpcErr instanceof Error ? rpcErr.message.slice(0, 200) : String(rpcErr),
      };
    }
  } catch (buildErr) {
    return {
      probed: false,
      likelyActive: "unknown",
      detail: buildErr instanceof Error ? buildErr.message.slice(0, 200) : String(buildErr),
    };
  }
}
