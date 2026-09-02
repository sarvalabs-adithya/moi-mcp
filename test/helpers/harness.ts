/**
 * Boots the REAL McpServer tool handlers in-process and talks to them through
 * the SDK's own Client over a linked in-memory transport, so tests exercise
 * the exact code path an MCP client does: input validation, the handler, and
 * output-schema validation on both server and client sides.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

import { resetConfigCache } from "../../src/config.js";
import { resetProviderCache } from "../../src/moi/provider.js";
import { DEFAULT_REGISTRY_LOGIC_ID } from "../../src/moi/registry.js";
import { registerResources } from "../../src/resources/index.js";
import { registerReadTools } from "../../src/tools/reads.js";
import { registerWalletTools, resetWalletClient, setWalletClient } from "../../src/tools/wallet.js";
import { registerWriteTools } from "../../src/tools/writes.js";
import type { SignClientLike, WcConfig } from "../../src/wc/client.js";
import { saveSession, type Session } from "../../src/wc/session.js";
import { ACCOUNT } from "./mock-node.js";

/** A syntactically valid Reown project id (32 hex). Never reaches a relay. */
export const PROJECT_ID = "0123456789abcdef0123456789abcdef";

export interface Harness {
  client: Client;
  server: McpServer;
  home: string;
  /** Result of the LAST tool call, as the client saw it. */
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

export interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
  /** All text blocks joined. */
  text: string;
}

const MANAGED_ENV = [
  "WC_PROJECT_ID",
  "MOI_NETWORK",
  "MOI_RPC_URL",
  "MOI_MCP_HOME",
  "REQUEST_TIMEOUT_MS",
  "LOG_LEVEL",
  "MOI_EXPLORER_URL",
  "MOI_READ_CALLER",
  "MOI_WC_PARAM_STYLE",
  "MOI_AGENT_REGISTRY_LOGIC_ID",
] as const;

let savedEnv: Record<string, string | undefined> | undefined;

/**
 * Point the server at the mock node. Values are set explicitly for every key
 * config reads, so a developer's .env (which dotenv only uses for UNSET keys)
 * cannot leak into a test.
 */
export function applyEnv(rpcUrl: string, home: string, overrides: Record<string, string> = {}): void {
  savedEnv ??= Object.fromEntries(MANAGED_ENV.map((k) => [k, process.env[k]]));
  for (const key of MANAGED_ENV) delete process.env[key];
  Object.assign(process.env, {
    WC_PROJECT_ID: PROJECT_ID,
    MOI_NETWORK: "custom",
    MOI_RPC_URL: rpcUrl,
    MOI_MCP_HOME: home,
    REQUEST_TIMEOUT_MS: "2000",
    LOG_LEVEL: "silent",
    MOI_EXPLORER_URL: "https://voyage.moi.technology",
    MOI_AGENT_REGISTRY_LOGIC_ID: DEFAULT_REGISTRY_LOGIC_ID,
    ...overrides,
  });
  resetConfigCache();
  resetProviderCache();
  resetWalletClient();
}

export function restoreEnv(): void {
  if (!savedEnv) return;
  for (const key of MANAGED_ENV) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv = undefined;
  resetConfigCache();
  resetProviderCache();
  resetWalletClient();
}

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "moi-tools-"));
}

/** Build the server exactly as src/index.ts does (minus `ping`). */
export function buildServer(): McpServer {
  const server = new McpServer({ name: "moi-mcp-test", version: "0.0.0" });
  registerReadTools(server);
  registerWalletTools(server);
  registerWriteTools(server);
  registerResources(server);
  return server;
}

export async function startHarness(
  rpcUrl: string,
  options: { home?: string; env?: Record<string, string> } = {},
): Promise<Harness> {
  const home = options.home ?? tempHome();
  applyEnv(rpcUrl, home, options.env);

  const server = buildServer();
  const client = new Client({ name: "harness", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  // Caches every tool's outputSchema so callTool validates structuredContent
  // client-side too — the layer the write-tool regression slipped past.
  await client.listTools();

  return {
    client,
    server,
    home,
    async call(name, args = {}) {
      const raw = (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
      const content = raw.content ?? [];
      return {
        ...raw,
        content,
        text: content.map((c) => c.text ?? "").join("\n"),
      };
    },
    async close() {
      await client.close();
      await server.close();
      rmSync(home, { recursive: true, force: true });
      restoreEnv();
    },
  };
}

// ---------------------------------------------------------------------------
// Wallet fake
// ---------------------------------------------------------------------------

export interface WcRequest {
  topic: string;
  chainId: string;
  request: { method: string; params: unknown[] };
}

export interface FakeWallet {
  client: SignClientLike;
  request: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  /** Every request the "phone" received, in order. */
  requests: WcRequest[];
}

export const SIGNED = { ix_args: "0e5f0300", signatures: "0e1f03deadbeef" };

/**
 * Stand in for the SignClient + phone. `respond` decides what the wallet
 * answers with; the default signs anything. Throwing from it models a
 * rejection on the phone.
 */
export function fakeWallet(
  respond: (req: WcRequest) => unknown = () => SIGNED,
): FakeWallet {
  const requests: WcRequest[] = [];
  const request = vi.fn(async (args: unknown) => {
    const req = args as WcRequest;
    requests.push(req);
    return respond(req);
  });
  const disconnect = vi.fn(async () => {});
  const client: SignClientLike = {
    connect: vi.fn(async () => ({
      uri: "wc:test@2?relay-protocol=irn",
      approval: async () => new Promise(() => {}),
    })),
    request: request as SignClientLike["request"],
    disconnect,
    on: vi.fn(),
    session: { keys: [], get: () => undefined },
  };
  return { client, request, disconnect, requests };
}

/** Install a fake wallet on the tool layer for the current config. */
export function installWallet(home: string, wallet: FakeWallet, cfg: Partial<WcConfig> = {}): void {
  setWalletClient(
    {
      projectId: PROJECT_ID,
      home,
      network: "custom",
      requestTimeoutMs: 2000,
      ...cfg,
    },
    async () => wallet.client,
  );
}

/** Write a paired session into MOI_MCP_HOME, as a completed pairing would. */
export function seedSession(home: string, overrides: Partial<Session> = {}): Session {
  const now = Math.floor(Date.now() / 1000);
  const session: Session = {
    version: 1,
    topic: "topic-test",
    pairingTopic: "pairing-test",
    account: ACCOUNT,
    chainId: "moi:custom",
    network: "custom",
    peer: { name: "MOI Wallet", url: "https://wallet.moi.technology" },
    expiry: now + 3600,
    createdAt: now * 1000,
    ...overrides,
  };
  saveSession(home, session);
  return session;
}
