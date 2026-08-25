/**
 * Chain reads. No MCP imports — plain TS library.
 *
 * Every function returns the exact shape declared in schema.*Output so the
 * tool layer can hand the result straight to structuredContent.
 */

import { AssetId, AssetStandard, type JsonRpcProvider } from "js-moi-sdk";
import { z } from "zod";

import { MoiError, asRpcError } from "../moi-error.js";
import {
  ErrorCode,
  GetAccountOutput,
  GetAssetOutput,
  GetInteractionOutput,
  GetLogicOutput,
} from "../schema.js";

// ---------------------------------------------------------------------------
// Amount handling
// ---------------------------------------------------------------------------

/** RPC returns quantities as hex strings ("0x1e"), decimal strings, or numbers. */
export function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string") {
    const s = value.trim();
    if (s === "") return 0n;
    try {
      return /^0[xX]/.test(s) ? BigInt(s) : BigInt(s);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

/**
 * Scale a raw integer amount by an asset's dimension into an exact decimal
 * string. Never uses floating point — MOI supplies are up to 2^64 and a
 * double would silently lose precision above 2^53.
 *
 * normalizeAmount(1500n, 2) === "15"
 * normalizeAmount(1234n, 6) === "0.001234"
 */
export function normalizeAmount(raw: unknown, dimension: number): string {
  const value = toBigInt(raw);
  const scale = Number.isFinite(dimension) ? Math.max(0, Math.trunc(dimension)) : 0;
  if (scale === 0) return value.toString();

  const divisor = 10n ** BigInt(scale);
  const whole = value / divisor;
  const fraction = value % divisor;
  if (fraction === 0n) return whole.toString();

  const digits = fraction.toString().padStart(scale, "0").replace(/0+$/, "");
  return `${whole}.${digits}`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

type Provider = JsonRpcProvider;

/** MOI ids are typed (participant/asset/logic); the SDK validates the kind. */
function invalidId(kind: string, value: string, err: unknown): MoiError {
  const detail = err instanceof Error ? err.message : String(err);
  return new MoiError(ErrorCode.INVALID_ARGS, `Not a valid MOI ${kind} id: ${value}. ${detail}`, {
    value,
  });
}

export async function getAccount(
  provider: Provider,
  address: string,
): Promise<z.infer<typeof GetAccountOutput>> {
  let state: Awaited<ReturnType<Provider["getAccountState"]>>;
  try {
    state = await provider.getAccountState(address);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/identifier|invalid/i.test(detail)) throw invalidId("participant", address, err);
    throw asRpcError(err, `moi.AccountState(${address})`);
  }

  // A participant with no state has never been registered on chain.
  let isRegistered = true;
  try {
    const meta = await provider.getAccountMetaInfo(address);
    isRegistered = Boolean(meta?.state_exists ?? true);
  } catch {
    // Non-fatal: meta info is a nicety, the account state above is the truth.
  }

  // TDU = the account's holdings across every asset it touches.
  const balances: Array<{ assetId: string; symbol?: string; amount: string }> = [];
  try {
    const tdu = (await provider.getTDU(address)) as unknown as Array<Record<string, unknown>>;
    for (const entry of tdu ?? []) {
      const assetId = String(entry["asset_id"] ?? entry["token_id"] ?? "");
      if (!/^0x[0-9a-fA-F]+$/.test(assetId)) continue;
      balances.push({ assetId, amount: toBigInt(entry["amount"]).toString() });
    }
  } catch (err) {
    throw asRpcError(err, `moi.TDU(${address})`);
  }

  return {
    address,
    nonce: Number(toBigInt(state.nonce)),
    balances,
    isRegistered,
  };
}

export async function getAsset(
  provider: Provider,
  assetId: string,
): Promise<z.infer<typeof GetAssetOutput>> {
  let info: Awaited<ReturnType<Provider["getAssetInfoByAssetID"]>>;
  try {
    info = await provider.getAssetInfoByAssetID(assetId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/identifier|invalid/i.test(detail)) throw invalidId("asset", assetId, err);
    throw asRpcError(err, `moi.AssetInfoByAssetID(${assetId})`);
  }

  const dimension = Number(toBigInt(info.dimension ?? info.decimals ?? 0));

  return {
    assetId,
    symbol: info.symbol ?? "",
    standard: assetStandardName(assetId),
    supply: normalizeAmount(info.circulating_supply ?? info.max_supply ?? 0, dimension),
    dimension,
    owner: info.creator ?? info.manager ?? "0x0",
    isLogical: Boolean(info.logic_id),
    ...(info.logic_id ? { logicId: info.logic_id } : {}),
  };
}

/** Receipt status is numeric on the wire; 0 means the interaction succeeded. */
function receiptStatus(status: unknown): "pending" | "success" | "failed" | "unknown" {
  const n = Number(toBigInt(status));
  if (Number.isNaN(n)) return "unknown";
  return n === 0 ? "success" : "failed";
}

export async function getInteraction(
  provider: Provider,
  hash: string,
): Promise<z.infer<typeof GetInteractionOutput>> {
  let ix: Record<string, unknown>;
  try {
    ix = (await provider.getInteractionByHash(hash)) as unknown as Record<string, unknown>;
  } catch (err) {
    throw asRpcError(err, `moi.InteractionByHash(${hash})`);
  }

  // The receipt carries execution status; it is absent while still pending.
  let receipt: Record<string, unknown> | undefined;
  try {
    receipt = (await provider.getInteractionReceipt(hash)) as unknown as Record<string, unknown>;
  } catch {
    receipt = undefined;
  }

  const rawOps = (ix["ix_operations"] ?? ix["operations"] ?? []) as Array<Record<string, unknown>>;
  const operations = (Array.isArray(rawOps) ? rawOps : []).map((op) => ({
    type: String(op["type"] ?? "unknown"),
    payload: (op["payload"] ?? {}) as Record<string, unknown>,
  }));

  const out: z.infer<typeof GetInteractionOutput> = {
    hash,
    status: receipt ? receiptStatus(receipt["status"]) : "pending",
    sender: String(ix["sender"] ?? (ix["sender"] as never) ?? receipt?.["from"] ?? "0x0"),
    operations,
  };

  if (receipt?.["fuel_used"] !== undefined) {
    out.fuelUsed = Number(toBigInt(receipt["fuel_used"]));
  }
  if (receipt) out.receipt = receipt;

  return out;
}

const ROUTINE_KINDS = new Set(["invoke", "deploy", "enlist", "view"]);

/** Map a manifest routine's declared kind onto the four the schema allows. */
function routineKind(raw: unknown): "invoke" | "deploy" | "enlist" | "view" {
  const k = String(raw ?? "").toLowerCase();
  if (ROUTINE_KINDS.has(k)) return k as "invoke" | "deploy" | "enlist" | "view";
  // Cocolang marks read-only routines with a `!` mutability flag in some
  // manifest versions; anything not otherwise named is treated as invoke.
  return k.includes("view") || k.includes("read") ? "view" : "invoke";
}

export async function getLogic(
  provider: Provider,
  logicId: string,
): Promise<z.infer<typeof GetLogicOutput>> {
  let manifest: unknown;
  try {
    // "JSON" encoding returns a parsed manifest rather than POLO bytes.
    manifest = await provider.getLogicManifest(logicId, "JSON" as never);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (/identifier|invalid/i.test(detail)) throw invalidId("logic", logicId, err);
    throw asRpcError(err, `moi.LogicManifest(${logicId})`);
  }

  const parsed = (typeof manifest === "string" ? safeJson(manifest) : manifest) as
    | Record<string, unknown>
    | undefined;

  const elements = (parsed?.["elements"] ?? []) as Array<Record<string, unknown>>;
  const routines = (Array.isArray(elements) ? elements : [])
    .filter((el) => String(el["kind"] ?? "") === "routine")
    .map((el) => {
      const data = (el["data"] ?? {}) as Record<string, unknown>;
      const accepts = (data["accepts"] ?? []) as Array<Record<string, unknown>>;
      const returns = (data["returns"] ?? []) as Array<Record<string, unknown>>;
      const field = (f: Record<string, unknown>) => ({
        name: String(f["label"] ?? f["name"] ?? ""),
        type: String(f["type"] ?? ""),
      });
      return {
        name: String(data["name"] ?? ""),
        kind: routineKind(data["kind"] ?? data["mode"]),
        inputs: (Array.isArray(accepts) ? accepts : []).map(field),
        outputs: (Array.isArray(returns) ? returns : []).map(field),
      };
    });

  const name = parsed?.["name"];

  return {
    logicId,
    ...(typeof name === "string" ? { name } : {}),
    routines,
  };
}

/**
 * AssetInfo carries no `standard` field — the standard is encoded in the asset
 * identifier itself (bytes 2..3). Decode it and name it (MAS0/MAS1/...).
 */
export function assetStandardName(assetId: string): string {
  try {
    const code = new AssetId(assetId as `0x${string}`).getStandard();
    return (AssetStandard as unknown as Record<number, string>)[code] ?? `UNKNOWN(${code})`;
  } catch {
    return "";
  }
}

function safeJson(s: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
