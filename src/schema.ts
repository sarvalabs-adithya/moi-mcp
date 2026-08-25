/**
 * @moi-protocol/mcp-server — canonical schemas
 *
 * Single source of truth for:
 *   1. MCP tool input/output shapes (zod, used by McpServer.registerTool)
 *   2. WalletConnect v2 request/response payloads (moi.* namespace)
 *   3. On-disk session store
 *   4. Error codes returned to the agent
 *
 * TODO(adithya): confirm CAIP-2 chain ids + exact ix_args encoding against
 * sarvalabs/moi-wallet-mobile/Dapp-docs (private repo) before Phase 2.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// 0. Shared primitives
// ---------------------------------------------------------------------------

export const Network = z.enum(["voyage", "mainnet", "custom"]);
export type Network = z.infer<typeof Network>;

/** MOI identifiers are 0x-prefixed hex. Keep loose; SDK validates strictly. */
export const HexId = z.string().regex(/^0x[0-9a-fA-F]+$/, "expected 0x-hex");

/** Asset id on MOI (native assets). */
export const AssetId = HexId;

/** Logic (Cocolang program) id. */
export const LogicId = HexId;

/** Human-readable amount as string to avoid float drift. e.g. "12.5" */
export const Amount = z.string().regex(/^\d+(\.\d+)?$/, "decimal string");

export const InteractionHash = HexId;

/** CAIP-2 chain id used in WalletConnect namespaces. CONFIRM VALUES. */
export const CAIP2 = z.record(Network, z.string()).default({
  voyage: "moi:voyage",     // TODO confirm
  mainnet: "moi:mainnet",   // TODO confirm
  custom: "moi:custom",
});

// ---------------------------------------------------------------------------
// 1. Wallet / session tools
// ---------------------------------------------------------------------------

export const ConnectWalletInput = z.object({
  network: Network.default("voyage"),
  /** If true, return QR as PNG image block. Else return URI text only. */
  qr: z.boolean().default(true),
});

export const ConnectWalletOutput = z.object({
  status: z.enum(["awaiting_scan", "connected", "already_connected"]),
  uri: z.string().optional(),          // wc:...@2?relay-protocol=...
  expiresAt: z.number().optional(),    // unix ms
  account: HexId.optional(),
  network: Network.optional(),
});

export const WalletStatusInput = z.object({});

export const WalletStatusOutput = z.object({
  connected: z.boolean(),
  account: HexId.optional(),
  network: Network.optional(),
  chainId: z.string().optional(),      // CAIP-2 from session
  peerName: z.string().optional(),     // "MOI Wallet"
  expiry: z.number().optional(),
  pendingRequests: z.number(),
});

export const DisconnectWalletInput = z.object({
  reason: z.string().max(200).optional(),
});

// ---------------------------------------------------------------------------
// 2. Read tools (js-moi-providers, no wallet needed)
// ---------------------------------------------------------------------------

export const GetAccountInput = z.object({
  address: HexId.describe("Account address. Defaults to connected wallet."),
});

export const GetAccountOutput = z.object({
  address: HexId,
  nonce: z.number(),
  balances: z.array(
    z.object({ assetId: AssetId, symbol: z.string().optional(), amount: Amount })
  ),
  isRegistered: z.boolean(),
});

export const GetAssetInput = z.object({ assetId: AssetId });

export const GetAssetOutput = z.object({
  assetId: AssetId,
  symbol: z.string(),
  standard: z.string(),                 // MAS0 etc.
  supply: Amount,
  dimension: z.number(),
  owner: HexId,
  isLogical: z.boolean(),
  logicId: LogicId.optional(),
});

export const GetInteractionInput = z.object({ hash: InteractionHash });

export const GetInteractionOutput = z.object({
  hash: InteractionHash,
  status: z.enum(["pending", "success", "failed", "unknown"]),
  sender: HexId,
  operations: z.array(
    z.object({ type: z.string(), payload: z.record(z.string(), z.unknown()) })
  ),
  fuelUsed: z.number().optional(),
  blockHeight: z.number().optional(),
  receipt: z.record(z.string(), z.unknown()).optional(),
});

export const GetLogicInput = z.object({ logicId: LogicId });

export const GetLogicOutput = z.object({
  logicId: LogicId,
  name: z.string().optional(),
  routines: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(["invoke", "deploy", "enlist", "view"]),
      inputs: z.array(z.object({ name: z.string(), type: z.string() })),
      outputs: z.array(z.object({ name: z.string(), type: z.string() })),
    })
  ),
});

export const ResolveAgentInput = z.object({
  /** Agent registry handle, name, or address. */
  query: z.string().min(1),
});

export const ResolveAgentOutput = z.object({
  found: z.boolean(),
  agentId: z.string().optional(),
  address: HexId.optional(),
  name: z.string().optional(),
  capabilities: z.array(z.string()).default([]),
  endpoint: z.string().url().optional(),   // x402 / service URL
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// 3. Write tools (build ix locally → moi.sendInteractions via WalletConnect)
//    All write tools return the same envelope.
// ---------------------------------------------------------------------------

export const WriteResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("sent"),
    hash: InteractionHash,
    explorerUrl: z.string().url(),
  }),
  z.object({
    status: z.literal("rejected"),
    reason: z.enum(["user_rejected", "timeout", "network_mismatch", "wallet_disconnected"]),
    message: z.string(),
  }),
  z.object({
    status: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
]);
export type WriteResult = z.infer<typeof WriteResult>;

export const TransferInput = z.object({
  to: HexId,
  assetId: AssetId.describe("Native asset id. Use MOI asset id for gas token."),
  amount: Amount,
  memo: z.string().max(140).optional(),
});

export const CreateAssetInput = z.object({
  symbol: z.string().min(1).max(12),
  supply: Amount,
  dimension: z.number().int().min(0).max(18).default(0),
  standard: z.string().default("MAS0"),
  isStateful: z.boolean().default(false),
  isFungible: z.boolean().default(true),
});

export const CallLogicInput = z.object({
  logicId: LogicId,
  routine: z.string().min(1),
  args: z.array(z.unknown()).default([]),
  /** "view" runs locally via provider (no wallet). "invoke" goes to wallet. */
  kind: z.enum(["invoke", "view"]).default("invoke"),
});

export const CallLogicViewOutput = z.object({
  routine: z.string(),
  outputs: z.record(z.string(), z.unknown()),
});

// ---------------------------------------------------------------------------
// 4. WalletConnect v2 payloads (moi.* namespace)
//    Mirrors docs.wallet.moi.technology/features/dapp-connections
// ---------------------------------------------------------------------------

export const WC_METHODS = ["moi.signInteraction", "moi.sendInteractions"] as const;
export const WC_EVENTS = ["accountsChanged", "chainChanged"] as const;

/** Namespace we request on pairing. */
export const WcRequiredNamespaces = z.object({
  moi: z.object({
    chains: z.array(z.string()),                  // ["moi:voyage"]
    methods: z.array(z.enum(WC_METHODS)),
    events: z.array(z.enum(WC_EVENTS)),
  }),
});

/**
 * Request param for moi.sendInteractions.
 * The wallet signs AND broadcasts; returns hash.
 * ix_args encoding: CONFIRM against Dapp-docs (POLO-encoded hex vs JSON object).
 */
export const WcSendInteractionsParams = z.object({
  ix_args: z.union([z.string(), z.record(z.string(), z.unknown())]),
  /** Optional UI hints the wallet may render. */
  meta: z
    .object({
      dappName: z.string().default("MOI MCP Server"),
      description: z.string().optional(),   // "Transfer 50 MOI to pricefeed-01"
    })
    .optional(),
});

export const WcSendInteractionsResult = z.object({
  hash: InteractionHash,
});

/** Request param for moi.signInteraction (v2 feature: sign-only, we broadcast). */
export const WcSignInteractionParams = WcSendInteractionsParams;

export const WcSignInteractionResult = z.object({
  ix_args: z.union([z.string(), z.record(z.string(), z.unknown())]),
  signature: z.string(),
});

// ---------------------------------------------------------------------------
// 5. Session store  (~/.moi-mcp/session.json)
// ---------------------------------------------------------------------------

export const SessionStore = z.object({
  version: z.literal(1),
  topic: z.string(),                 // WC session topic
  pairingTopic: z.string().optional(),
  account: HexId,
  chainId: z.string(),               // CAIP-2
  network: Network,
  peer: z.object({ name: z.string(), url: z.string().optional() }),
  expiry: z.number(),                // unix s (WC expiry)
  createdAt: z.number(),
});
export type SessionStore = z.infer<typeof SessionStore>;

// ---------------------------------------------------------------------------
// 6. Config (env)
// ---------------------------------------------------------------------------

export const Config = z.object({
  MOI_NETWORK: Network.default("voyage"),
  MOI_RPC_URL: z.string().url().optional(),     // override for "custom"
  WC_PROJECT_ID: z.string().min(1),             // ship a default in package
  MOI_MCP_HOME: z.string().default("~/.moi-mcp"),
  MOI_EXPLORER_URL: z.string().url().default("https://voyage.moi.technology"), // TODO confirm
  REQUEST_TIMEOUT_MS: z.coerce.number().default(300_000), // 5 min
  LOG_LEVEL: z.enum(["silent", "error", "info", "debug"]).default("error"),
});
export type Config = z.infer<typeof Config>;

// ---------------------------------------------------------------------------
// 7. Error codes (string codes in WriteResult.error.code / thrown McpError data)
// ---------------------------------------------------------------------------

export const ErrorCode = {
  WALLET_NOT_CONNECTED: "WALLET_NOT_CONNECTED",
  NETWORK_MISMATCH: "NETWORK_MISMATCH",       // session chain != MOI_NETWORK
  USER_REJECTED: "USER_REJECTED",
  REQUEST_TIMEOUT: "REQUEST_TIMEOUT",
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  INVALID_ARGS: "INVALID_ARGS",
  RPC_ERROR: "RPC_ERROR",
  AGENT_NOT_FOUND: "AGENT_NOT_FOUND",
  LOGIC_ROUTINE_NOT_FOUND: "LOGIC_ROUTINE_NOT_FOUND",
  RELAY_UNAVAILABLE: "RELAY_UNAVAILABLE",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

// ---------------------------------------------------------------------------
// 8. Tool registry manifest (name → schema) — used by index.ts to register
// ---------------------------------------------------------------------------

export const TOOLS = {
  moi_connect_wallet:    { input: ConnectWalletInput,    write: false },
  moi_wallet_status:     { input: WalletStatusInput,     write: false },
  moi_disconnect_wallet: { input: DisconnectWalletInput, write: false },
  moi_get_account:       { input: GetAccountInput,       write: false },
  moi_get_asset:         { input: GetAssetInput,         write: false },
  moi_get_interaction:   { input: GetInteractionInput,   write: false },
  moi_get_logic:         { input: GetLogicInput,         write: false },
  moi_resolve_agent:     { input: ResolveAgentInput,     write: false },
  moi_transfer:          { input: TransferInput,         write: true  },
  moi_create_asset:      { input: CreateAssetInput,      write: true  },
  moi_call_logic:        { input: CallLogicInput,        write: true  },
} as const;
export type ToolName = keyof typeof TOOLS;
