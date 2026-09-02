/**
 * Wallet/session tools through the real handlers, with the SignClient faked.
 */

import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessionPath } from "../../src/wc/session.js";
import { ACCOUNT, startMockNode, type MockNode } from "../helpers/mock-node.js";
import {
  fakeWallet,
  installWallet,
  seedSession,
  startHarness,
  type Harness,
} from "../helpers/harness.js";

let node: MockNode;
let h: Harness | undefined;

beforeEach(async () => {
  node = await startMockNode();
});

afterEach(async () => {
  await h?.close();
  h = undefined;
  await node.close();
});

describe("moi_wallet_status", () => {
  it("unpaired: connected:false with a healthy config", async () => {
    h = await startHarness(node.url);
    installWallet(h.home, fakeWallet());

    const result = await h.call("moi_wallet_status");
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      connected: false,
      configOk: true,
      pendingRequests: 0,
      caip2Verified: false,
    });
    expect(result.structuredContent?.["configError"]).toBeUndefined();
    expect(result.structuredContent?.["account"]).toBeUndefined();
  });

  it("paired: reports the account, network and expiry from session.json", async () => {
    h = await startHarness(node.url);
    installWallet(h.home, fakeWallet());
    const session = seedSession(h.home);

    const result = await h.call("moi_wallet_status");
    expect(result.structuredContent).toMatchObject({
      connected: true,
      configOk: true,
      account: ACCOUNT,
      network: "custom",
      chainId: "moi:custom",
      peerName: "MOI Wallet",
      expiry: session.expiry,
    });
  });

  it("placeholder WC_PROJECT_ID: configOk:false and points at cloud.reown.com", async () => {
    h = await startHarness(node.url, { env: { WC_PROJECT_ID: "replace_me" } });

    const result = await h.call("moi_wallet_status");
    // A broken config is exactly what this tool exists to report: no isError.
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ connected: false, configOk: false });
    expect(String(result.structuredContent?.["configError"])).toMatch(/cloud\.reown\.com/);
    expect(String(result.structuredContent?.["configError"])).toMatch(/replace_me/);
  });

  it("odd-looking but usable WC_PROJECT_ID: loads, but flags it", async () => {
    h = await startHarness(node.url, { env: { WC_PROJECT_ID: "abc123" } });
    installWallet(h.home, fakeWallet());

    const result = await h.call("moi_wallet_status");
    expect(result.structuredContent).toMatchObject({ connected: false, configOk: false });
    expect(String(result.structuredContent?.["configError"])).toMatch(/32 hex/);
  });

  it("session on another network: connected:false with the mismatch explained", async () => {
    h = await startHarness(node.url);
    installWallet(h.home, fakeWallet());
    seedSession(h.home, { network: "voyage", chainId: "moi:14" });

    const result = await h.call("moi_wallet_status");
    expect(result.structuredContent).toMatchObject({ connected: false, configOk: true, network: "voyage" });
    expect(String(result.structuredContent?.["configError"])).toMatch(/voyage.*custom/);
  });
});

describe("moi_connect_wallet", () => {
  it("with a valid session: already_connected, and no pairing is started", async () => {
    h = await startHarness(node.url);
    const wallet = fakeWallet();
    installWallet(h.home, wallet);
    const session = seedSession(h.home);

    const result = await h.call("moi_connect_wallet", { qr: false });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      status: "already_connected",
      account: ACCOUNT,
      network: "custom",
      expiresAt: session.expiry * 1000,
    });
    expect(result.text).toMatch(/already paired/i);
    expect(wallet.client.connect).not.toHaveBeenCalled();
  });

  it("unpaired: returns the pairing URI and awaits the scan", async () => {
    h = await startHarness(node.url);
    const wallet = fakeWallet();
    installWallet(h.home, wallet);

    const result = await h.call("moi_connect_wallet", { qr: false });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: "awaiting_scan",
      uri: "wc:test@2?relay-protocol=irn",
      network: "custom",
    });
    expect(result.text).toContain("wc:test@2");
    expect(result.content.every((c) => c.type === "text")).toBe(true);
    expect(wallet.client.connect).toHaveBeenCalledTimes(1);
  });

  it("qr:true adds a PNG image block", async () => {
    h = await startHarness(node.url);
    installWallet(h.home, fakeWallet());

    const result = await h.call("moi_connect_wallet", { qr: true });
    const image = result.content.find((c) => c.type === "image") as
      | { type: "image"; mimeType: string; data: string }
      | undefined;
    expect(image?.mimeType).toBe("image/png");
    expect(image?.data.length).toBeGreaterThan(100);
  });
});

describe("moi_disconnect_wallet", () => {
  it("ends the relay session and removes session.json", async () => {
    h = await startHarness(node.url);
    const wallet = fakeWallet();
    installWallet(h.home, wallet);
    seedSession(h.home, { topic: "topic-to-close" });

    const result = await h.call("moi_disconnect_wallet", { reason: "test over" });
    expect(result.isError).toBeFalsy();
    expect(result.text).toBe("Wallet disconnected.");
    expect(existsSync(sessionPath(h.home))).toBe(false);
    expect(wallet.disconnect).toHaveBeenCalledWith({
      topic: "topic-to-close",
      reason: { code: 6000, message: "test over" },
    });

    // Idempotent: the second call reports there was nothing to do.
    const again = await h.call("moi_disconnect_wallet");
    expect(again.text).toBe("No wallet was paired.");
    expect(wallet.disconnect).toHaveBeenCalledTimes(1);
  });

  it("still clears the local session when the relay is unreachable", async () => {
    h = await startHarness(node.url);
    const wallet = fakeWallet();
    wallet.disconnect.mockRejectedValueOnce(new Error("relay down"));
    installWallet(h.home, wallet);
    seedSession(h.home);

    const result = await h.call("moi_disconnect_wallet");
    expect(result.text).toBe("Wallet disconnected.");
    expect(existsSync(sessionPath(h.home))).toBe(false);
  });
});
