/**
 * What a pairing's lifetime actually does on the write path.
 *
 * These go through the real MCP tool handler over an in-memory transport,
 * against the mock node, with only the store, hub and journal faked. A test
 * that pokes the store directly would pass no matter what the handler did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { AuthInfo } from "../../src/auth/types.js";
import { registerHostedWrites, type HostedWriteDeps } from "../../src/tools/hosted-writes.js";
import type { WalletConnectHubLike } from "../../src/wc/hub.js";
import type { StoredWalletSession, WalletSessionStore } from "../../src/wc/store.js";
import { ACCOUNT, KMOI, OTHER, SENT_HASH, startMockNode, type MockNode } from "../helpers/mock-node.js";
import { fakeWallet, installWallet, startHarness, type Harness } from "../helpers/harness.js";

let node: MockNode;
let h: Harness;

const USER = "user-a";
const TOPIC = "topic-a";
const TRANSFER = { to: OTHER, assetId: KMOI, amount: "1" };

beforeEach(async () => {
  node = await startMockNode();
  h = await startHarness(node.url);
  installWallet(h.home, fakeWallet());
});

afterEach(async () => {
  await h.close();
  await node.close();
});

function session(over: Partial<StoredWalletSession> = {}): StoredWalletSession {
  return {
    version: 1,
    userId: USER,
    topic: TOPIC,
    caip2: "moi:custom",
    address: ACCOUNT,
    sessionData: {},
    createdAt: new Date().toISOString(),
    ...over,
  };
}

function fakeStore(records: Map<string, StoredWalletSession>): WalletSessionStore {
  return {
    get: vi.fn(async (userId: string) => records.get(userId)),
    set: vi.fn(async (r: StoredWalletSession) => void records.set(r.userId, r)),
    delete: vi.fn(async (userId: string) => void records.delete(userId)),
    findByTopic: vi.fn(async (topic: string) => [...records.values()].find((r) => r.topic === topic)),
    list: vi.fn(async () => [...records.values()]),
  };
}

function fakeHub(): WalletConnectHubLike & { disconnect: ReturnType<typeof vi.fn>; signInteractionFor: ReturnType<typeof vi.fn> } {
  return {
    pair: vi.fn(async () => {
      throw new Error("not used here");
    }),
    signInteractionFor: vi.fn(async () => ({
      ix_args: "0x" + "1".repeat(64),
      signatures: "0x" + "2".repeat(128),
    })),
    onSessionDelete: vi.fn(() => () => {}),
    disconnect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

const auth: AuthInfo = {
  userId: USER,
  clientId: "c",
  scopes: ["moi:write"],
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

/** Wire a real McpServer with the hosted writes and hand back a connected client. */
async function connect(deps: HostedWriteDeps): Promise<Client> {
  const server = new McpServer({ name: "t", version: "0" });
  registerHostedWrites(server, deps, auth);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  return client;
}

function deps(store: WalletSessionStore, hub: WalletConnectHubLike): HostedWriteDeps {
  return {
    store,
    hub,
    journal: { append: vi.fn(async () => {}), update: vi.fn(async () => {}) },
  } as unknown as HostedWriteDeps;
}

describe("a once-only pairing", () => {
  it("is forgotten the moment its transaction is signed and broadcast", async () => {
    const records = new Map([[USER, session({ mode: "once", expiresAt: Math.floor(Date.now() / 1000) + 600 })]]);
    const store = fakeStore(records);
    const hub = fakeHub();
    const client = await connect(deps(store, hub));

    const result = await client.callTool({ name: "moi_transfer", arguments: TRANSFER });
    const out = result.structuredContent as { hash?: string; status?: string };

    expect(out.hash).toBe(SENT_HASH);
    expect(store.delete).toHaveBeenCalledWith(USER);
    expect(records.has(USER)).toBe(false);
    expect(hub.disconnect).toHaveBeenCalledWith(TOPIC);
  });

  it("cannot be used a second time", async () => {
    const records = new Map([[USER, session({ mode: "once", expiresAt: Math.floor(Date.now() / 1000) + 600 })]]);
    const store = fakeStore(records);
    const hub = fakeHub();
    const client = await connect(deps(store, hub));

    await client.callTool({ name: "moi_transfer", arguments: TRANSFER });
    const second = await client.callTool({ name: "moi_transfer", arguments: TRANSFER });
    const out = second.structuredContent as { status?: string; code?: string };

    expect(out.status).not.toBe("sent");
    expect(hub.signInteractionFor).toHaveBeenCalledTimes(1);
  });
});

describe("a persistent pairing", () => {
  it("survives being used", async () => {
    const records = new Map([
      [USER, session({ mode: "persistent", expiresAt: Math.floor(Date.now() / 1000) + 600 })],
    ]);
    const store = fakeStore(records);
    const hub = fakeHub();
    const client = await connect(deps(store, hub));

    const result = await client.callTool({ name: "moi_transfer", arguments: TRANSFER });
    expect((result.structuredContent as { hash?: string }).hash).toBe(SENT_HASH);

    expect(store.delete).not.toHaveBeenCalled();
    expect(hub.disconnect).not.toHaveBeenCalled();
    expect(records.has(USER)).toBe(true);
  });
});

describe("an expired pairing", () => {
  it("is refused before anything reaches the phone, and tidied up", async () => {
    const records = new Map([[USER, session({ mode: "persistent", expiresAt: Math.floor(Date.now() / 1000) - 1 })]]);
    const store = fakeStore(records);
    const hub = fakeHub();
    const client = await connect(deps(store, hub));

    const result = await client.callTool({ name: "moi_transfer", arguments: TRANSFER });
    const out = result.structuredContent as { status?: string; reason?: string; message?: string };

    expect(out.status).toBe("rejected");
    expect(out.reason).toBe("wallet_disconnected");
    expect(out.message).toMatch(/expired/i);
    expect(hub.signInteractionFor).not.toHaveBeenCalled();
    expect(store.delete).toHaveBeenCalledWith(USER);
  });

  it("with no expiresAt at all is aged from its creation date", async () => {
    // A record from before lifetimes existed, created eight days ago.
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const records = new Map([[USER, session({ createdAt: eightDaysAgo })]]);
    const store = fakeStore(records);
    const hub = fakeHub();
    const client = await connect(deps(store, hub));

    const result = await client.callTool({ name: "moi_transfer", arguments: TRANSFER });
    const out = result.structuredContent as { status?: string; reason?: string };
    expect(out.status).toBe("rejected");
    expect(out.reason).toBe("wallet_disconnected");
    expect(hub.signInteractionFor).not.toHaveBeenCalled();
  });
});
