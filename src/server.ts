#!/usr/bin/env node
/**
 * Hosted HTTP transport — the multi-user entry point for the MOI Claude
 * connector.
 *
 * Unlike src/http.ts (stateless, read-only, no auth) this endpoint carries a
 * real wallet surface behind OAuth: every request still builds a fresh,
 * throwaway McpServer (no session ID, nothing shared across requests — see
 * withModernSchemaDialect + StreamableHTTPServerTransport below), but when the
 * caller is authenticated it additionally registers the three per-user wallet
 * tools, backed by a WalletSessionStore keyed on the OAuth subject.
 *
 * LAZY AUTH. claude.ai's custom-connector flow does not run OAuth up front —
 * it calls a tool, and only on a 401 with `WWW-Authenticate: ...
 * resource_metadata="..."` does it show the inline Connect card and retry the
 * SAME call once the user has signed in. A 200 response with `isError` does
 * NOT trigger that UI, so every gated path below must answer with a real 401,
 * never a tool error. GATED lists every tool that needs a wallet or writes to
 * one, including moi_transfer/moi_create_asset/moi_mint/moi_call_logic —
 * write tools that this milestone does not yet register — so the gate is
 * already correct the day they land.
 *
 * Run:  moi-mcp-hosted        (HOSTED_PORT, default 8788)
 * Point an MCP client (or claude.ai's custom-connector field) at:
 *   http://host:HOSTED_PORT/mcp
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Application, type Request, type Response } from "express";
import { realpathSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { mountAuth, type AuthHandle, type AuthInfo } from "./auth/index.js";
import { getConfig, getHostedConfig, log } from "./config.js";
import { messageOf, toMcpError } from "./errors.js";
import { buildReadOnlyServer, MCP_PATH } from "./http.js";
import { withModernSchemaDialect } from "./json-schema-dialect.js";
import { WriteJournal } from "./journal.js";
import { NETWORKS } from "./moi/provider.js";
import type { Network } from "./schema.js";
import { createPairingLink as createPairingLinkFor, consumeForUser, mountPairing } from "./pairing/index.js";
import { registerMandateTools } from "./tools/mandates.js";
import { registerMandateExecutor } from "./tools/mandates-execute.js";
import { FileAgentKeyStore, type AgentKeyStore } from "./signing/agent-keys.js";
import { getProvider } from "./moi/provider.js";
import { MandateLedger } from "./mandates/ledger.js";
import { registerHostedWrites } from "./tools/hosted-writes.js";
import { WalletConnectHub, type WalletConnectHubLike } from "./wc/hub.js";
import { FileWalletSessionStore, type StoredWalletSession, type WalletSessionStore } from "./wc/store.js";

const MAX_BODY_BYTES = 1_000_000;

/**
 * Every tool that needs a wallet, or writes to the chain. Checked against
 * `params.name` for `tools/call` only — `initialize`, `tools/list`, and every
 * read tool/resource stay public. moi_transfer, moi_create_asset, moi_mint
 * and moi_call_logic are not registered by this file (that is the hosted
 * write path, a later milestone) but are listed here so the gate needs no
 * change when they land.
 */
export const GATED = [
  "moi_transfer",
  "moi_create_asset",
  "moi_mint",
  "moi_call_logic",
  "moi_connect_wallet",
  "moi_disconnect_wallet",
  "moi_wallet_status",
  "moi_mandate_status",
  "moi_grant_mandate",
  "moi_transfer_under_mandate",
] as const;

/**
 * Scope required per gated tool. moi_wallet_status only reads the paired
 * account, so a moi:read token covers it; every other gated tool either
 * moves funds/writes chain state or mutates the wallet pairing itself
 * (starting a new WalletConnect pairing, or tearing one down), so all of
 * them require moi:write. Keyed off GATED so adding a tool there without an
 * entry here is a compile error, not a silent unscoped gate.
 */
const REQUIRED_SCOPE: Record<(typeof GATED)[number], "moi:read" | "moi:write"> = {
  moi_transfer: "moi:write",
  moi_create_asset: "moi:write",
  moi_mint: "moi:write",
  moi_call_logic: "moi:write",
  moi_connect_wallet: "moi:write",
  moi_disconnect_wallet: "moi:write",
  moi_wallet_status: "moi:read",
  moi_mandate_status: "moi:read",
  moi_grant_mandate: "moi:write",
  moi_transfer_under_mandate: "moi:write",
};

export interface HostedDeps {
  authenticate: AuthHandle["authenticate"];
  challengeHeader: AuthHandle["challengeHeader"];
  store: WalletSessionStore;
  hub: WalletConnectHubLike;
  journal: WriteJournal;
  /** Per-user server-held agent keys, backing delegated-spend mandates. */
  agentKeys: AgentKeyStore;
  /** Mandate cap/expiry ledger, derived from the journal. */
  ledger: MandateLedger;
  /** Whether mountPairing(app, ...) was called on the outer app main() builds this onto. Surfaced at /health only — this app never serves /pair itself. */
  resolveUriMounted: boolean;
  /** One-arg wrapper over pairing/index.js's createPairingLink(userId, publicUrl) — the publicUrl is baked in by whoever builds this object. */
  createPairingLink(userId: string): { url: string; expiresAt: number };
  /** Wrapper that provides MOI_NETWORK and optional MOI_RPC_URL for the provider. */
  providerOptions(): { network: Network; rpcUrl?: string };
  /** Data directory for persisting agent keys and sessions. */
  dataDir: string;
}

/** Collect a JSON body, refusing anything oversized. Mirrors src/http.ts. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

/** The tool name of a `tools/call`, or undefined for anything else. */
function toolCallName(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const { method, params } = message as { method?: unknown; params?: unknown };
  if (method !== "tools/call") return undefined;
  const name = (params as { name?: unknown } | undefined)?.name;
  return typeof name === "string" ? name : undefined;
}

/** Every gated tool name `body` (a single JSON-RPC message, or a batch of them) calls. */
function gatedToolNames(body: unknown): Array<(typeof GATED)[number]> {
  const messages = Array.isArray(body) ? body : [body];
  const names: Array<(typeof GATED)[number]> = [];
  for (const m of messages) {
    const name = toolCallName(m);
    if (name !== undefined && (GATED as readonly string[]).includes(name)) {
      names.push(name as (typeof GATED)[number]);
    }
  }
  return names;
}

/** caip2 -> the network key NETWORKS lists it under, when it matches one we know. */
function networkForCaip2(caip2: string): string | undefined {
  return Object.values(NETWORKS).find((n) => n.caip2 === caip2)?.network;
}

const CONNECT_OUTPUT = { url: z.string().url(), expiresAt: z.number(), instructions: z.string() };
const WALLET_STATUS_OUTPUT = {
  connected: z.boolean(),
  address: z.string().optional(),
  caip2: z.string().optional(),
  network: z.string().optional(),
};

/**
 * Register the three per-user wallet tools onto an already-authenticated
 * request's ephemeral server. Never called for an unauthenticated request —
 * buildHostedApp only reaches this after deps.authenticate(req) succeeded.
 */
function registerWalletSurface(server: McpServer, deps: HostedDeps, auth: AuthInfo): void {
  server.registerTool(
    "moi_connect_wallet",
    {
      title: "Connect MOI Wallet",
      description:
        "Get a one-time link to pair MOI Wallet on your phone with this server over WalletConnect. " +
        "Open the link and scan the QR code with MOI Wallet, then call moi_wallet_status to confirm " +
        "the pairing landed. No private key ever reaches this server.",
      inputSchema: {},
      outputSchema: CONNECT_OUTPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        // NEVER put the raw wc: URI here — it carries a live relay symKey and
        // this response lands straight in the chat transcript. The link opens
        // a page (src/pairing/index.ts) that is the only place the URI is
        // ever resolved and rendered.
        const { url, expiresAt } = deps.createPairingLink(auth.userId);
        const structuredContent = {
          url,
          expiresAt,
          instructions: `Open this link and scan the QR code with MOI Wallet: ${url}`,
        };
        return {
          content: [{ type: "text" as const, text: structuredContent.instructions }],
          structuredContent,
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.registerTool(
    "moi_wallet_status",
    {
      title: "MOI Wallet status",
      description: "Report whether your MOI Wallet is paired to this server, and which account.",
      inputSchema: {},
      outputSchema: WALLET_STATUS_OUTPUT,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const record = await deps.store.get(auth.userId);
        const structuredContent = record
          ? {
              connected: true,
              address: record.address,
              caip2: record.caip2,
              ...(networkForCaip2(record.caip2) ? { network: networkForCaip2(record.caip2) } : {}),
            }
          : { connected: false };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
          structuredContent,
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.registerTool(
    "moi_disconnect_wallet",
    {
      title: "Disconnect MOI Wallet",
      description: "Forget your paired MOI Wallet session on this server.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      try {
        // TRUNK TODO: this deletes our record but does not tear down the
        // WalletConnect relay session (client.disconnect({topic})) — the
        // phone keeps showing the pairing as active until it expires on its
        // own. Fine for the trunk; needs the shared hub (PLAN-HOSTED.md
        // src/wc/hub.ts) to do properly, since only that holds the SignClient.
        await deps.store.delete(auth.userId);
        return { content: [{ type: "text" as const, text: "Wallet disconnected." }] };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}

/**
 * The hosted MCP endpoint, dependency-injected so tests need no real OAuth
 * server or WalletConnect relay. main() wires the real ones (mountAuth,
 * mountPairing, FileWalletSessionStore, a real createPairingLink) below.
 */
export function buildHostedApp(deps: HostedDeps): Application {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    let network = "unknown";
    let configOk = true;
    try {
      network = getConfig().MOI_NETWORK;
    } catch {
      configOk = false;
    }
    send(res, configOk ? 200 : 503, {
      ok: configOk,
      network,
      readOnly: false,
      pairingMounted: deps.resolveUriMounted,
    });
  });

  const handleMcp = async (req: Request, res: Response): Promise<void> => {
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      log("error", `hosted request failed: ${messageOf(err)}`);
      if (!res.headersSent) send(res, 400, { error: messageOf(err) });
      return;
    }

    // LAZY-AUTH GATE. Only a gated tools/call triggers authenticate(); every
    // other message (initialize, tools/list, a read tool, a resource) is
    // public and never even asks deps.authenticate for a token. A 200 with
    // isError does not make claude.ai show the Connect card — this 401 +
    // header is the only thing that does, so it must reach the client
    // untouched by the transport below.
    let auth: AuthInfo | undefined;
    const gatedTools = gatedToolNames(body);
    if (gatedTools.length > 0) {
      auth = deps.authenticate(req);
      if (!auth) {
        res.setHeader("WWW-Authenticate", deps.challengeHeader());
        send(res, 401, { error: "authorization required" });
        return;
      }

      // SCOPE GATE. Presence of a valid token is not enough — a moi:read-only
      // token must not be able to start/tear down a wallet pairing, transfer
      // funds, etc. Answer with the RFC 6750 §3.1 shape (403 +
      // error="insufficient_scope") so a client that understands scopes can
      // re-request authorization with the missing one instead of looping on
      // a 401 it can never resolve by re-presenting the same token.
      const missingScope = gatedTools
        .map((name) => REQUIRED_SCOPE[name])
        .find((scope) => !auth!.scopes.includes(scope));
      if (missingScope) {
        res.setHeader("WWW-Authenticate", deps.challengeHeader({ error: "insufficient_scope", scope: missingScope }));
        send(res, 403, {
          error: "insufficient_scope",
          error_description: `This action requires the '${missingScope}' scope.`,
        });
        return;
      }
    }

    // Stateless: a fresh server and transport per request, exactly like
    // src/http.ts, so concurrent callers can never observe each other's
    // state — and so an authenticated request's wallet tools never leak into
    // an unauthenticated one's tool list.
    const server = buildReadOnlyServer();
    if (auth) {
      registerWalletSurface(server, deps, auth);
      registerHostedWrites(server, deps, auth);
      registerMandateTools(
        server,
        {
          store: deps.store,
          journal: deps.journal,
          agentKeys: deps.agentKeys,
          ledger: deps.ledger,
          providerOptions: deps.providerOptions,
        },
        auth,
      );
      registerMandateExecutor(
        server,
        {
          store: deps.store,
          ledger: deps.ledger,
          agentKeys: deps.agentKeys,
          provider: {
            sendInteraction: async (req) => {
              const provider = getProvider(deps.providerOptions());
              return (provider as any).sendInteraction(req);
            },
            getPendingInteractionCount: async (id, keyId) => {
              const provider = getProvider(deps.providerOptions());
              return (provider as any).getPendingInteractionCount(id, keyId);
            },
          },
          dataDir: deps.dataDir,
          providerOptions: deps.providerOptions,
        },
        auth,
      );
    }

    const transport = withModernSchemaDialect(
      new StreamableHTTPServerTransport({ sessionIdGenerator: undefined }),
    );
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log("error", `request failed: ${messageOf(err)}`);
      if (!res.headersSent) send(res, 400, { error: messageOf(err) });
    }
  };

  app.post(MCP_PATH, handleMcp);
  app.get(MCP_PATH, handleMcp);
  app.delete(MCP_PATH, handleMcp);

  app.use((_req, res) => {
    send(res, 404, { error: `Not found. The MCP endpoint is ${MCP_PATH}.` });
  });

  return app;
}

// ---------------------------------------------------------------------------
// main() — wires the real auth server, pairing page, file-backed session
// store, and a WalletConnect client used only to resolve a pairing link's URI.
// ---------------------------------------------------------------------------

/**
 * Build the resolveUri callback mountPairing needs: start a WalletConnect
 * pairing, hand back the URI immediately for the QR page, and — once the
 * phone approves, in the background — persist the paired session and mark
 * the pairing link consumed.
 *
 * Pairing runs on the hub's SignClient, and that is load-bearing rather than
 * hygiene: signInteractionFor() resolves a topic against its own client's
 * session store, so a session paired on any other client is invisible to the
 * signer and every write for that user would fail "session no longer valid"
 * forever.
 *
 * The approved session is also written to `store` (FileWalletSessionStore,
 * keyed by sha256(userId)). That is the only place a tool may learn a
 * specific user's topic — the relay client itself has no notion of which
 * user paired, so asking it would give whoever paired most recently.
 */
function makeResolveUri(
  cfg: ReturnType<typeof getConfig>,
  hub: WalletConnectHubLike,
  store: WalletSessionStore,
): (userId: string) => Promise<string> {
  return async (userId: string): Promise<string> => {
    const { uri, approval } = await hub.pair(cfg.MOI_NETWORK);

    // Do not block the pairing page on the phone tap; it already polls via
    // its own cached-promise mechanism (src/pairing/index.ts handleGet).
    approval.then(
      async (session) => {
        const record: StoredWalletSession = {
          version: 1,
          userId,
          topic: session.topic,
          // The WalletConnect namespace key IS the CAIP-2 chain id here —
          // toSession() in wc/client.ts already resolved it against the
          // granted namespaces, not just what we requested.
          caip2: session.chainId,
          address: session.account,
          sessionData: session,
          createdAt: new Date(session.createdAt * 1000).toISOString(),
        };
        try {
          await store.set(record);
          consumeForUser(userId);
        } catch (err) {
          log("error", `failed to persist wallet session for a user: ${messageOf(err)}`);
        }
      },
      (err: unknown) => log("error", `pairing not completed: ${messageOf(err)}`),
    );

    return uri;
  };
}

/**
 * Keep `store` honest when a phone unpairs out-of-band: the relay's
 * session_delete event carries only a topic, resolved back to a userId via
 * `store.findByTopic` (never a caller-supplied identity — this is
 * server-to-server relay wiring, not a tool call).
 *
 * Exported so a test can assert the exact production wiring reconciles the
 * store, rather than only a copy of this logic re-registered inside the test
 * itself.
 */
export function wireSessionDeleteReconciliation(hub: WalletConnectHubLike, store: WalletSessionStore): void {
  hub.onSessionDelete((topic) => {
    void (async () => {
      try {
        const rec = await store.findByTopic(topic);
        if (rec) await store.delete(rec.userId);
      } catch (err) {
        log("error", `failed to reconcile session_delete for a topic: ${messageOf(err)}`);
      }
    })();
  });
}

/**
 * M5: reconcile any write left pending (proposed/signed/broadcast) by a
 * process restart between phone-sign and broadcast. This process never
 * persists the signed payload (ix_args/signatures) outside the request that
 * produced it, so a strand cannot be safely re-broadcast from the journal
 * alone — reconciling means reporting it honestly (loudly, once) and marking
 * it terminal so the next status check reflects reality instead of a tool
 * silently retrying against a stale nonce.
 */
async function reconcileJournalOnBoot(journal: WriteJournal): Promise<void> {
  await journal.reconcileOnBoot(async (entry) => {
    log(
      "error",
      `journal: interaction ${entry.id} (${entry.kind}, user ${entry.userId}) was left in state ` +
        `'${entry.state}' by a previous process exit and cannot be safely re-broadcast; marking orphaned.`,
    );
    await journal.update(entry.id, "orphaned", { detail: `reconciled on boot from state '${entry.state}'` });
  });
}

async function main(): Promise<void> {
  const cfg = getConfig(); // loads dotenv as a side effect; call before getHostedConfig()
  const hosted = getHostedConfig();

  const app = express();
  const { authenticate, challengeHeader } = mountAuth(app, {
    publicUrl: hosted.PUBLIC_URL,
    dataDir: hosted.dataDir,
  });

  const store = new FileWalletSessionStore(hosted.dataDir);
  const hub = await WalletConnectHub.init({
    projectId: cfg.WC_PROJECT_ID,
    home: hosted.dataDir,
    network: cfg.MOI_NETWORK,
    requestTimeoutMs: cfg.REQUEST_TIMEOUT_MS,
  });
  const journal = new WriteJournal(hosted.dataDir);
  wireSessionDeleteReconciliation(hub, store);
  await reconcileJournalOnBoot(journal);
  const agentKeys = new FileAgentKeyStore(hosted.dataDir);
  const ledger = new MandateLedger(journal, hosted.dataDir);

  // Recover spends stranded by a previous crash before serving traffic. Anything
  // that provably never reached the chain gives its cap back; anything that might
  // have landed keeps holding it and is named here so it can be resolved by hand.
  try {
    const { released, held } = await ledger.reconcileStranded();
    if (released.length > 0) {
      log("info", `released ${released.length} mandate spend(s) that never reached the chain`);
    }
    for (const s of held) {
      log(
        "error",
        `mandate spend ${s.journalEntryId} (user ${s.userId}, amount ${s.amount}) was mid-broadcast ` +
          `at shutdown; its cap stays held until someone confirms on chain whether it landed`,
      );
    }
  } catch (err) {
    log("error", `mandate reconciliation failed at startup: ${messageOf(err)}`);
  }
  mountPairing(app, { resolveUri: makeResolveUri(cfg, hub, store) });

  const providerOptions = () => ({ network: cfg.MOI_NETWORK, rpcUrl: cfg.MOI_RPC_URL });

  app.use(
    buildHostedApp({
      authenticate,
      challengeHeader,
      store,
      hub,
      journal,
      agentKeys,
      ledger,
      resolveUriMounted: true,
      createPairingLink: (userId: string) => createPairingLinkFor(userId, hosted.PUBLIC_URL),
      providerOptions,
      dataDir: hosted.dataDir,
    }),
  );

  app.listen(hosted.HOSTED_PORT, () => {
    // Never log a token, cookie, or pairing URL — only what is safe in a
    // shared process log.
    log(
      "info",
      `moi-mcp-hosted listening on :${hosted.HOSTED_PORT}${MCP_PATH} (public url ${hosted.PUBLIC_URL}, network ${cfg.MOI_NETWORK})`,
    );
  });
}

// npm installs bins as SYMLINKS (node_modules/.bin/moi-mcp-hosted ->
// dist/server.js), so argv[1]'s basename differs from this module's file
// name and a naive endsWith() check makes the bin exit silently. Compare
// realpaths instead — copied from src/http.ts, which hit this bug first.
const isMain = (() => {
  try {
    return process.argv[1]
      ? import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
      : false;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err: unknown) => {
    process.stderr.write(`[moi-mcp] fatal: ${messageOf(err)}\n`);
    process.exit(1);
  });
}
