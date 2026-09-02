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

import { getConfig, log } from "../config.js";
import { toMcpError } from "../errors.js";
import { isMoiError, MoiError } from "../moi-error.js";
import {
  assertSendable,
  buildCreateAsset,
  buildLogicInvoke,
  buildMint,
  buildTransfer,
  encodeLogicCall,
  chooseStorageFund,
  estimateFuelFor,
  parseAmount,
  simulate,
  type SenderInfo,
  type UnsignedInteraction,
} from "../moi/ix-builder.js";
import { getProvider, getReadOnlySigner, interactionUrl } from "../moi/provider.js";
import { getAccount, getAsset, toBigInt } from "../moi/reads.js";
import {
  CallLogicInput,
  CallLogicViewOutput,
  CreateAssetInput,
  ErrorCode,
  MintInput,
  TransferInput,
  WriteResult,
} from "../schema.js";
import { requireSession } from "../wc/session.js";
import { walletClient } from "./wallet.js";

type Write = z.infer<typeof WriteResult>;

/**
 * Replace the built-in fuel ceiling with a measured one.
 *
 * A fuel_limit far above the real cost is the number a human sees on the
 * approval screen, so an unmeasured default reads as though the interaction
 * is enormous.
 */
/**
 * Refuse to push an interaction that the node says will revert.
 *
 * Without this the user is asked to approve something on their phone that then
 * burns fuel and fails — the worst outcome, because it looks like their
 * approval caused the failure.
 */
async function assertWillSucceed(ix: UnsignedInteraction, hint?: string): Promise<void> {
  const provider = getProvider(providerOptions()) as unknown as { call: (i: unknown) => Promise<unknown> };
  const result = await simulate(provider, ix);
  if (result.ok) return;

  throw new MoiError(
    ErrorCode.INVALID_ARGS,
    `The node says this interaction would fail (receipt status ${result.status ?? "?"})` +
      `${result.detail ? `: ${result.detail}` : ""}. ` +
      `Not sending it to your wallet — approving it would burn fuel and change nothing.` +
      (hint ? ` ${hint}` : ""),
    { simulatedStatus: result.status ?? null },
  );
}

async function withMeasuredFuel(ix: UnsignedInteraction): Promise<UnsignedInteraction> {
  const provider = getProvider(providerOptions()) as unknown as {
    estimateFuel: (i: unknown) => Promise<number | bigint>;
  };
  const { fuelLimit, estimated, reason } = await estimateFuelFor(provider, ix);
  if (!estimated) log("info", `fuel estimation unavailable (${reason}); using fallback ${fuelLimit}`);
  return { ...ix, fuel_limit: fuelLimit };
}

/** KMOI the account holds, in base units. */
async function kmoiBalance(account: string): Promise<bigint> {
  const { KMOI_ASSET_ID } = await import("js-moi-sdk");
  const state = await getAccount(getProvider(providerOptions()), account);
  const held = state.balances.find(
    (b) => b.assetId.toLowerCase() === String(KMOI_ASSET_ID).toLowerCase(),
  );
  return toBigInt(held?.amount ?? 0);
}

function providerOptions() {
  const cfg = getConfig();
  return { network: cfg.MOI_NETWORK, rpcUrl: cfg.MOI_RPC_URL };
}

/**
 * Resolve the sequence number the chain expects next.
 *
 * This must match what js-moi-sdk's Signer.getNonce() would produce —
 * getPendingInteractionCount(id, keyId), which counts queued interactions too.
 * Reading AccountState.nonce instead yields undefined (the node does not
 * return that field), which silently becomes 0 and the wallet rejects the
 * interaction with "invalid nonce".
 */
async function senderFor(account: string, keyId = 0): Promise<SenderInfo> {
  const provider = getProvider(providerOptions()) as unknown as {
    getPendingInteractionCount: (id: string, keyId: number) => Promise<number | bigint>;
  };
  const sequence = Number(await provider.getPendingInteractionCount(account, keyId));
  return { id: account, sequence, keyId };
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

/**
 * The write path: sign on the phone, broadcast from here.
 *
 * Splitting sign from broadcast is what makes writes work at all right now —
 * the wallet's combined sendInteractions is broken (see wc/client.ts). It also
 * keeps the zero-key property: the signature is produced on the phone and this
 * process only relays it to the node.
 */
async function signAndBroadcast(
  session: Parameters<typeof requireSession>[0] extends undefined ? never : NonNullable<ReturnType<typeof requireSession>>,
  ix: UnsignedInteraction,
  description: string,
): Promise<string> {
  const signed = await walletClient().signInteraction(session, ix, { description });

  const provider = getProvider(providerOptions()) as unknown as {
    sendInteraction: (req: { ix_args: string; signatures: string }) => Promise<{ hash: string }>;
  };
  try {
    const response = await provider.sendInteraction(signed);
    const hash = response?.hash;
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]+$/.test(hash)) {
      throw new MoiError(ErrorCode.RPC_ERROR, `Node accepted the interaction but returned no hash.`);
    }
    return hash;
  } catch (err) {
    if (err instanceof MoiError) throw err;
    throw new MoiError(
      ErrorCode.RPC_ERROR,
      `You approved the interaction but broadcasting it failed: ${err instanceof Error ? err.message.slice(0, 180) : String(err)}`,
    );
  }
}

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

        const ix = await withMeasuredFuel(
          buildTransfer(await senderFor(session.account), { to, assetId, amount: raw }),
        );
        assertSendable(ix);
        await assertWillSucceed(ix);

        const hash = await signAndBroadcast(
          session,
          ix,
          `Transfer ${amount} ${asset.symbol || assetId} to ${to}${memo ? ` — ${memo}` : ""}`,
        );

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
        const wc = walletClient();
        const session = requireSession(await wc.currentSession(), cfg.MOI_NETWORK);

        const ix = await withMeasuredFuel(
          buildCreateAsset(await senderFor(session.account), {
            symbol,
            supply: parseAmount(supply, dimension),
            dimension,
            standard,
            isStateful,
            isFungible,
            // Omitted -> size it from the balance. The SDK's 1,000,000 default
            // exceeds most devnet accounts and fails opaquely.
            storageFund: storageFund
              ? parseAmount(storageFund, 0)
              : chooseStorageFund(await kmoiBalance(session.account)),
          }),
        );
        assertSendable(ix);
        await assertWillSucceed(
          ix,
          `A new asset must be funded with KMOI to pay its own storage (default ` +
            `1000000). Pass a smaller \`storageFund\` if your balance cannot cover it — ` +
            `below roughly 10000 the asset cannot pay for storage at all.`,
        );

        const hash = await signAndBroadcast(session, ix, `Create asset ${symbol} with supply ${supply}`);

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
        const wc = walletClient();
        const session = requireSession(await wc.currentSession(), cfg.MOI_NETWORK);

        const asset = await getAsset(getProvider(providerOptions()), assetId);
        const recipient = to ?? session.account;
        const raw = parseAmount(amount, asset.dimension);

        const ix = await withMeasuredFuel(
          await buildMint(
            getReadOnlySigner(providerOptions()),
            await senderFor(session.account),
            { assetId, to: recipient, amount: raw },
          ),
        );
        assertSendable(ix);
        await assertWillSucceed(
          ix,
          `Minting requires you to be the asset's manager, and the new total cannot exceed its ` +
            `maximum supply.`,
        );

        const hash = await signAndBroadcast(
          session,
          ix,
          `Mint ${amount} ${asset.symbol || assetId} to ${recipient}`,
        );

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
        // no wallet-client construction either: currentSession() would spin up
        // a real SignClient (relay connection, wc.db) for a read.
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

        const wc = walletClient();
        const valid = requireSession(await wc.currentSession(), cfg.MOI_NETWORK);
        const payload = await encodeLogicCall(
          getReadOnlySigner(providerOptions()),
          logicId,
          routine,
          args,
        );
        const ix = await withMeasuredFuel(
          buildLogicInvoke(await senderFor(valid.account), {
            logicId,
            callsite: routine,
            ...(payload.calldata ? { calldata: payload.calldata } : {}),
          }),
        );
        assertSendable(ix);
        await assertWillSucceed(ix);

        const hash = await signAndBroadcast(valid, ix, `Call ${routine} on logic ${logicId}`);

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
