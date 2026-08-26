/**
 * Write tools. Every one of these builds an interaction locally and hands it to
 * MOI Wallet for approval. None of them can sign.
 *
 * Each write runs the same guard sequence before touching the relay:
 *   1. a valid session exists            -> WALLET_NOT_CONNECTED
 *   2. that session is on our network    -> NETWORK_MISMATCH
 *   3. (transfer) the balance covers it  -> INSUFFICIENT_BALANCE
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getConfig } from "../config.js";
import { toMcpError } from "../errors.js";
import { isMoiError, MoiError } from "../moi-error.js";
import {
  assertSendable,
  buildCreateAsset,
  buildLogicInvoke,
  buildTransfer,
  encodeLogicCall,
  parseAmount,
  toPoloHex,
  type SenderInfo,
} from "../moi/ix-builder.js";
import { getProvider, getReadOnlySigner, interactionUrl } from "../moi/provider.js";
import { getAccount, getAsset, toBigInt } from "../moi/reads.js";
import {
  CallLogicInput,
  CallLogicViewOutput,
  CreateAssetInput,
  ErrorCode,
  TransferInput,
  WriteResult,
} from "../schema.js";
import { paramStyle } from "../wc/client.js";
import { requireSession } from "../wc/session.js";
import { walletClient } from "./wallet.js";

type Write = z.infer<typeof WriteResult>;

function providerOptions() {
  const cfg = getConfig();
  return { network: cfg.MOI_NETWORK, rpcUrl: cfg.MOI_RPC_URL };
}

/** Resolve the paired account's current interaction count. */
async function senderFor(account: string): Promise<SenderInfo> {
  const state = await getAccount(getProvider(providerOptions()), account);
  return { id: account, sequence: state.nonce, keyId: 0 };
}

/**
 * Convert a thrown error into the schema's WriteResult envelope where the
 * schema models it (rejection reasons), and rethrow everything else so the
 * client sees a real MCP error.
 */
function asWriteResult(err: unknown): Write {
  if (isMoiError(err)) {
    switch (err.code) {
      case ErrorCode.USER_REJECTED:
        return { status: "rejected", reason: "user_rejected", message: err.message };
      case ErrorCode.REQUEST_TIMEOUT:
        return { status: "rejected", reason: "timeout", message: err.message };
      case ErrorCode.NETWORK_MISMATCH:
        return { status: "rejected", reason: "network_mismatch", message: err.message };
      case ErrorCode.WALLET_NOT_CONNECTED:
        return { status: "rejected", reason: "wallet_disconnected", message: err.message };
      default:
        break;
    }
  }
  throw toMcpError(err);
}

/**
 * Advertised output shape for the write tools.
 *
 * schema.WriteResult is a discriminated union, and MCP SDK 1.30's zod-compat
 * layer cannot convert a Zod 3 union into JSON Schema (it probes Zod 4's
 * internals and throws on `_zod`). We therefore advertise the permissive
 * superset of the three variants, and still validate the real value against
 * WriteResult below — so the strict contract holds even though the published
 * schema is looser.
 */
const WriteOutputShape = {
  status: z.enum(["sent", "rejected", "error"]),
  hash: z.string().optional(),
  explorerUrl: z.string().optional(),
  reason: z.enum(["user_rejected", "timeout", "network_mismatch", "wallet_disconnected"]).optional(),
  message: z.string().optional(),
  code: z.string().optional(),
};

function ok(value: Write) {
  // Enforce the union even though the advertised schema is the superset.
  const checked = WriteResult.parse(value);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(checked, null, 2) }],
    structuredContent: checked as Record<string, unknown>,
  };
}

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export function registerWriteTools(server: McpServer): void {
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
        const wc = walletClient();
        const session = requireSession(await wc.currentSession(), cfg.MOI_NETWORK);

        const provider = getProvider(providerOptions());
        const asset = await getAsset(provider, assetId);
        const raw = parseAmount(amount, asset.dimension);

        const account = await getAccount(provider, session.account);
        const held = account.balances.find((b) => b.assetId.toLowerCase() === assetId.toLowerCase());
        const heldRaw = toBigInt(held?.amount ?? 0);
        if (heldRaw < raw) {
          throw new MoiError(
            ErrorCode.INSUFFICIENT_BALANCE,
            `Account ${session.account} holds ${held?.amount ?? "0"} of ${asset.symbol || assetId} ` +
              `in base units but the transfer needs ${raw.toString()}.`,
            { assetId, needed: raw.toString(), held: held?.amount ?? "0" },
          );
        }

        const ix = buildTransfer(await senderFor(session.account), { to, assetId, amount: raw });
        assertSendable(ix);

        const hash = await wc.sendInteraction(session, ix, {
          description: `Transfer ${amount} ${asset.symbol || assetId} to ${to}${memo ? ` — ${memo}` : ""}`,
          ...(paramStyle() === "ix_args" ? { poloHex: toPoloHex(ix) } : {}),
        });

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
        "Propose creating a new MOI native asset (a token). Sent to MOI Wallet for approval on " +
        "your phone. `dimension` is the number of decimal places; `standard` is MAS0, MAS1, MAS2 " +
        "or MASX.",
      inputSchema: CreateAssetInput.shape,
      outputSchema: WriteOutputShape,
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ symbol, supply, dimension, standard, isStateful, isFungible }) => {
      try {
        const cfg = getConfig();
        const wc = walletClient();
        const session = requireSession(await wc.currentSession(), cfg.MOI_NETWORK);

        const ix = buildCreateAsset(await senderFor(session.account), {
          symbol,
          supply: parseAmount(supply, dimension),
          dimension,
          standard,
          isStateful,
          isFungible,
        });
        assertSendable(ix);

        const hash = await wc.sendInteraction(session, ix, {
          description: `Create asset ${symbol} with supply ${supply}`,
          ...(paramStyle() === "ix_args" ? { poloHex: toPoloHex(ix) } : {}),
        });

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
        const wc = walletClient();
        const session = await wc.currentSession();

        // A view runs against the node directly — no wallet, no approval.
        if (kind === "view") {
          const signer = getReadOnlySigner(providerOptions());
          const { getLogicDriver } = await import("js-moi-sdk");
          const driver = (await getLogicDriver(logicId, signer as never)) as unknown as {
            routines: Record<string, (...a: unknown[]) => Promise<{ call: () => Promise<{ result: () => unknown }> }>>;
          };
          const fn = driver.routines[routine];
          if (typeof fn !== "function") {
            throw new MoiError(
              ErrorCode.LOGIC_ROUTINE_NOT_FOUND,
              `Logic ${logicId} has no routine "${routine}". Available: ${Object.keys(driver.routines ?? {}).join(", ")}.`,
            );
          }
          const response = await (await fn(...args)).call();
          const outputs = (await response.result()) as Record<string, unknown>;
          const value: z.infer<typeof CallLogicViewOutput> = {
            routine,
            outputs: JSON.parse(
              JSON.stringify(outputs, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
            ) as Record<string, unknown>,
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
            structuredContent: value,
          };
        }

        const valid = requireSession(session, cfg.MOI_NETWORK);
        const payload = await encodeLogicCall(
          getReadOnlySigner(providerOptions()),
          logicId,
          routine,
          args,
        );
        const ix = buildLogicInvoke(await senderFor(valid.account), {
          logicId,
          callsite: routine,
          ...(payload.calldata ? { calldata: payload.calldata } : {}),
        });
        assertSendable(ix);

        const hash = await wc.sendInteraction(valid, ix, {
          description: `Call ${routine} on logic ${logicId}`,
          ...(paramStyle() === "ix_args" ? { poloHex: toPoloHex(ix) } : {}),
        });

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
