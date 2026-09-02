/**
 * Hosted transport: the lazy-auth gate over real HTTP, and per-request wallet
 * tool registration. buildHostedApp takes fake auth/store deps, so none of
 * this touches a real OAuth server or WalletConnect relay.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AuthInfo } from "../../src/auth/index.js";
import { TOOLS } from "../../src/schema.js";
import { buildHostedApp, GATED, type HostedDeps } from "../../src/server.js";
import type { StoredWalletSession, WalletSessionStore } from "../../src/wc/store.js";
import { applyEnv, restoreEnv, tempHome } from "../helpers/harness.js";
import { ACCOUNT, startMockNode, type MockNode } from "../helpers/mock-node.js";

const VALID_TOKEN = "test-token";
const AUTH_INFO: AuthInfo = {
  userId: "user-1",
  clientId: "client-1",
  scopes: ["moi:read", "moi:write"],
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

function fakeAuthenticate(req: { headers: { authorization?: string | string[] | undefined } }): AuthInfo | undefined {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  return value === `Bearer ${VALID_TOKEN}` ? AUTH_INFO : undefined;
}

function fakeChallengeHeader(): string {
  return (
    'Bearer error="invalid_token", error_description="Authorization required", ' +
    'resource_metadata="https://example.test/.well-known/oauth-protected-resource"'
  );
}

class FakeStore implements WalletSessionStore {
  private records = new Map<string, StoredWalletSession>();
  async get(userId: string): Promise<StoredWalletSession | undefined> {
    return this.records.get(userId);
  }
  async set(record: StoredWalletSession): Promise<void> {
    this.records.set(record.userId, record);
  }
  async delete(userId: string): Promise<void> {
    this.records.delete(userId);
  }
  async findByTopic(topic: string): Promise<StoredWalletSession | undefined> {
    return [...this.records.values()].find((r) => r.topic === topic);
  }
  async list(): Promise<StoredWalletSession[]> {
    return [...this.records.values()];
  }
}

function makeDeps(store: WalletSessionStore): HostedDeps {
  return {
    authenticate: fakeAuthenticate,
    challengeHeader: fakeChallengeHeader,
    store,
    resolveUriMounted: true,
    createPairingLink: (userId) => ({
      url: `https://example.test/pair/${userId}`,
      expiresAt: Date.now() + 300_000,
    }),
  };
}

/** POST one JSON-RPC message and return both the raw response and its decoded body. */
async function rpc(
  baseUrl: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Headers; json: any }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // The transport answers as a single-event SSE stream; a gate rejection
  // (401/400) answers as plain JSON instead. Handle both.
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  const json = dataLine ? JSON.parse(dataLine.slice("data: ".length)) : text ? JSON.parse(text) : undefined;
  return { status: res.status, headers: res.headers, json };
}

function toolCall(id: number, name: string, args: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

describe("hosted transport", () => {
  let node: MockNode;
  let server: Server;
  let baseUrl: string;
  let store: FakeStore;

  beforeAll(async () => {
    node = await startMockNode();
  });

  afterAll(async () => {
    await node.close();
  });

  beforeEach(async () => {
    applyEnv(node.url, tempHome());
    node.reset();
    store = new FakeStore();

    const app = buildHostedApp(makeDeps(store));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    restoreEnv();
  });

  it("gates moi_transfer behind auth: 401 with a WWW-Authenticate resource_metadata challenge", async () => {
    const { status, headers, json } = await rpc(baseUrl, toolCall(1, "moi_transfer", { to: ACCOUNT }));
    expect(status).toBe(401);
    expect(headers.get("www-authenticate")).toContain("resource_metadata");
    expect(json).toEqual({ error: "authorization required" });
  });

  it("lets an unauthenticated caller use ping and moi_get_account", async () => {
    const ping = await rpc(baseUrl, toolCall(1, "ping"));
    expect(ping.status).toBe(200);
    expect(ping.json.result.isError).toBeFalsy();

    const account = await rpc(baseUrl, toolCall(2, "moi_get_account", { address: ACCOUNT }));
    expect(account.status).toBe(200);
    expect(account.json.result.isError).toBeFalsy();
    expect(account.json.result.structuredContent.address).toBe(ACCOUNT);
  });

  it("reports wallet status false, then true after the store is seeded, for an authenticated caller", async () => {
    const auth = { authorization: `Bearer ${VALID_TOKEN}` };

    const before = await rpc(baseUrl, toolCall(1, "moi_wallet_status"), auth);
    expect(before.status).toBe(200);
    expect(before.json.result.structuredContent).toEqual({ connected: false });

    await store.set({
      version: 1,
      userId: AUTH_INFO.userId,
      topic: "topic-1",
      caip2: "moi:14",
      address: ACCOUNT,
      sessionData: { ok: true },
      createdAt: new Date().toISOString(),
    });

    const after = await rpc(baseUrl, toolCall(2, "moi_wallet_status"), auth);
    expect(after.status).toBe(200);
    expect(after.json.result.structuredContent).toMatchObject({
      connected: true,
      address: ACCOUNT,
      caip2: "moi:14",
    });
  });

  it("still 401s an unauthenticated moi_wallet_status call", async () => {
    const { status, json } = await rpc(baseUrl, toolCall(1, "moi_wallet_status"));
    expect(status).toBe(401);
    expect(json).toEqual({ error: "authorization required" });
  });

  it("GATED covers every wallet tool and every write tool in the schema's TOOLS manifest", () => {
    const gated = GATED as readonly string[];
    const writeTools = Object.entries(TOOLS)
      .filter(([, def]) => def.write)
      .map(([name]) => name);
    const walletTools = ["moi_connect_wallet", "moi_wallet_status", "moi_disconnect_wallet"];

    for (const name of [...writeTools, ...walletTools]) {
      expect(gated, `GATED must include ${name}`).toContain(name);
    }
  });
});
