/**
 * Builds unsigned MOI interactions. No MCP imports, and — by construction — no
 * keys: everything here stops at the unsigned InteractionObject.
 *
 * Two encodings exist and are easy to confuse:
 *
 *   1. WalletConnect (dapp -> MOI Wallet). The wallet is handed the plain
 *      InteractionObject positionally: `params: [ixObject]`. Evidenced by
 *      sarvalabs/wallet-connect-dapp src/contexts/JsonRpcContext.tsx, which
 *      calls `request({ method: "moi.sendInteractions", params: [assetContext] })`
 *      where assetContext is `await builder.ixData(...)`, typed InteractionObject.
 *
 *   2. Node JSON-RPC (wallet -> MOI node). `moi.SendInteractions` takes
 *      `{ ix_args, signatures }` where ix_args is POLO-encoded hex. That is what
 *      js-moi-wallet's signInteraction produces:
 *      `ix_args: bytesToHex(serializeIxObject(ixObject))`.
 *
 * We are case 1. `toPoloHex` implements case 2 anyway — without keys — so the
 * encoding is switchable if the wallet turns out to want it (PLAN open Q1).
 */

import {
  AssetStandard,
  bytesToHex,
  buildTransferPayload,
  ixObjectSchema,
  LockType,
  OpType,
  toRawInteractionObject,
} from "js-moi-sdk";
import { Polorizer } from "js-polo";

import { MoiError } from "../moi-error.js";
import { ErrorCode } from "../schema.js";

/** The node rejects interactions carrying more than three operations. */
export const MAX_OPERATIONS = 3;

export const DEFAULT_FUEL_PRICE = 1;

/**
 * Fallback ceiling, used only when estimation fails.
 *
 * Deliberately not a tight number: it is a MAXIMUM, and the point of the
 * fallback is that we could not measure. Real estimates are ~300 fuel for a
 * transfer, so anything we build normally uses estimateFuelFor() below —
 * a fuel_limit three orders of magnitude above the real cost is alarming on
 * the wallet's approval screen, which is the one place a human is checking.
 */
export const DEFAULT_FUEL_LIMIT = 200_000;

/** Headroom over the measured estimate, for state that shifts between
 *  estimation and execution. */
export const FUEL_MARGIN = 1.5;

export interface SenderInfo {
  /** Participant id of the account that will sign — the paired wallet. */
  id: string;
  /** Interaction count for that account. */
  sequence: number;
  keyId?: number;
}

export interface BuildOptions {
  fuelPrice?: number;
  fuelLimit?: number;
}

export interface UnsignedInteraction {
  sender: { id: string; sequence: number; key_id: number };
  fuel_price: number;
  fuel_limit: number;
  ix_operations: Array<{ type: number; payload: Record<string, unknown> }>;
  participants?: Array<{ id: string; lock_type: number; notary: boolean }>;
  /** bigint, not a decimal string — POLO rejects strings here. */
  funds?: Array<{ asset_id: string; amount: bigint }>;
}

/**
 * Scale a human decimal string up into the asset's base units.
 * parseAmount("1.5", 6) === 1500000n
 */
export function parseAmount(amount: string, dimension: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new MoiError(ErrorCode.INVALID_ARGS, `Amount must be a decimal string, got "${amount}"`, {
      amount,
    });
  }
  const scale = Math.max(0, Math.trunc(dimension || 0));
  const [whole = "0", fraction = ""] = amount.split(".");
  if (fraction.length > scale) {
    throw new MoiError(
      ErrorCode.INVALID_ARGS,
      `Amount ${amount} has ${fraction.length} decimal places but the asset's dimension is ${scale}.`,
      { amount, dimension: scale },
    );
  }
  return BigInt(whole + fraction.padEnd(scale, "0"));
}

function base(sender: SenderInfo, options: BuildOptions): Omit<UnsignedInteraction, "ix_operations"> {
  return {
    sender: { id: sender.id, sequence: sender.sequence, key_id: sender.keyId ?? 0 },
    fuel_price: options.fuelPrice ?? DEFAULT_FUEL_PRICE,
    fuel_limit: options.fuelLimit ?? DEFAULT_FUEL_LIMIT,
  };
}

/** Asset transfer. The recipient must be declared as a participant. */
export function buildTransfer(
  sender: SenderInfo,
  params: { to: string; assetId: string; amount: bigint },
  options: BuildOptions = {},
): UnsignedInteraction {
  const payload = buildTransferPayload(
    params.assetId as `0x${string}`,
    params.to as `0x${string}`,
    params.amount,
  );

  return {
    ...base(sender, options),
    funds: [{ asset_id: params.assetId, amount: params.amount }],
    ix_operations: [{ type: OpType.ASSET_INVOKE, payload: payload as unknown as Record<string, unknown> }],
    participants: [{ id: params.to, lock_type: LockType.MUTATE_LOCK, notary: false }],
  };
}

export function buildCreateAsset(
  sender: SenderInfo,
  params: {
    symbol: string;
    supply: bigint;
    dimension: number;
    standard: string;
    isStateful: boolean;
    isFungible: boolean;
  },
  options: BuildOptions = {},
): UnsignedInteraction {
  const standardCode = (AssetStandard as unknown as Record<string, number>)[params.standard];
  if (standardCode === undefined) {
    throw new MoiError(
      ErrorCode.INVALID_ARGS,
      `Unknown asset standard "${params.standard}". Expected one of MAS0, MAS1, MAS2, MASX.`,
      { standard: params.standard },
    );
  }

  return {
    ...base(sender, options),
    ix_operations: [
      {
        type: OpType.ASSET_CREATE,
        // Field names and types come from js-moi-sdk's AssetCreatePayload.
        // max_supply must be a number|bigint — a decimal string fails POLO
        // serialisation inside the wallet with "Failed to sign interaction",
        // and there is no `supply` field at all.
        payload: {
          symbol: params.symbol,
          max_supply: params.supply,
          dimension: params.dimension,
          standard: standardCode,
          enable_events: params.isStateful,
          manager: sender.id,
        },
      },
    ],
  };
}

export function buildLogicInvoke(
  sender: SenderInfo,
  params: { logicId: string; callsite: string; calldata?: string },
  options: BuildOptions = {},
): UnsignedInteraction {
  return {
    ...base(sender, options),
    ix_operations: [
      {
        type: OpType.LOGIC_INVOKE,
        payload: {
          logic_id: params.logicId,
          callsite: params.callsite,
          ...(params.calldata ? { calldata: params.calldata } : {}),
        },
      },
    ],
  };
}

/**
 * Measure the fuel an interaction needs, with headroom.
 *
 * Falls back to DEFAULT_FUEL_LIMIT when the node cannot simulate — asset
 * creation currently reverts during estimation on devnet, and refusing to
 * build the interaction over that would be worse than overestimating.
 */
export async function estimateFuelFor(
  estimator: { estimateFuel: (ix: unknown) => Promise<number | bigint> },
  ix: UnsignedInteraction,
): Promise<{ fuelLimit: number; estimated: boolean; reason?: string }> {
  try {
    const raw = await estimator.estimateFuel(ix);
    const measured = Number(raw);
    if (!Number.isFinite(measured) || measured <= 0) {
      return { fuelLimit: DEFAULT_FUEL_LIMIT, estimated: false, reason: "node returned no usable estimate" };
    }
    return { fuelLimit: Math.ceil(measured * FUEL_MARGIN), estimated: true };
  } catch (err) {
    return {
      fuelLimit: DEFAULT_FUEL_LIMIT,
      estimated: false,
      reason: err instanceof Error ? err.message.slice(0, 120) : String(err),
    };
  }
}

/** Reject anything the node would reject anyway, with a clearer message. */
export function assertSendable(ix: UnsignedInteraction): void {
  if (ix.ix_operations.length === 0) {
    throw new MoiError(ErrorCode.INVALID_ARGS, "Interaction has no operations.");
  }
  if (ix.ix_operations.length > MAX_OPERATIONS) {
    throw new MoiError(
      ErrorCode.INVALID_ARGS,
      `An interaction may carry at most ${MAX_OPERATIONS} operations, got ${ix.ix_operations.length}.`,
    );
  }
}

/**
 * POLO-encode to the node-level `ix_args` hex. Mirrors js-moi-wallet's
 * serializeIxObject using only public exports — and without a key, since
 * encoding and signing are separate steps.
 *
 * Returns UNPREFIXED hex. js-moi-wallet sets `ix_args: bytesToHex(ixData)`,
 * and the node's documented payload is bare hex too. Do not add "0x".
 */
export function toPoloHex(ix: UnsignedInteraction): string {
  try {
    const polorizer = new Polorizer();
    polorizer.polorize(toRawInteractionObject(ix as never), ixObjectSchema);
    return bytesToHex(polorizer.bytes());
  } catch (err) {
    throw new MoiError(
      ErrorCode.INVALID_ARGS,
      `Could not POLO-encode the interaction: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Logic call encoding
// ---------------------------------------------------------------------------

interface RoutineCtx {
  ctx?: { opType?: number; payload?: Record<string, unknown> };
}

/**
 * Ask the SDK's logic driver to encode a routine call, rather than
 * hand-rolling POLO calldata. Calling `driver.routines.X(...args)` returns a
 * request whose `ctx.payload` is exactly the LOGIC_INVOKE payload we need:
 * `{ logic_id, callsite, calldata }`.
 */
export async function encodeLogicCall(
  signer: unknown,
  logicId: string,
  callsite: string,
  args: unknown[],
): Promise<{ logic_id: string; callsite: string; calldata?: string }> {
  const { getLogicDriver } = await import("js-moi-sdk");
  let driver: { routines: Record<string, (...a: unknown[]) => Promise<RoutineCtx>> };
  try {
    driver = (await getLogicDriver(logicId, signer as never)) as never;
  } catch (err) {
    throw new MoiError(
      ErrorCode.RPC_ERROR,
      `Could not load logic ${logicId}: ${err instanceof Error ? err.message : String(err)}`,
      { logicId },
    );
  }

  const routine = driver.routines[callsite];
  if (typeof routine !== "function") {
    const available = Object.keys(driver.routines ?? {}).join(", ");
    throw new MoiError(
      ErrorCode.LOGIC_ROUTINE_NOT_FOUND,
      `Logic ${logicId} has no routine "${callsite}". Available: ${available || "(none)"}.`,
      { logicId, callsite, available },
    );
  }

  const request = await routine(...args);
  const payload = request.ctx?.payload;
  if (!payload) {
    throw new MoiError(ErrorCode.INVALID_ARGS, `Could not encode a call to ${callsite}.`);
  }
  return payload as { logic_id: string; callsite: string; calldata?: string };
}
