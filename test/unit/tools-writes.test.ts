/**
 * Write tools through the real handlers. The node and the phone are both
 * faked, so every test can assert on the ORDER of side effects — which guard
 * fired, and that nothing reached the wallet or the node before it did.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WriteResult } from "../../src/schema.js";
import {
  ACCOUNT,
  KMOI,
  LOGIC,
  OTHER,
  SENT_HASH,
  startMockNode,
  type MockNode,
} from "../helpers/mock-node.js";
import {
  fakeWallet,
  installWallet,
  seedSession,
  signatureFor,
  startHarness,
  type FakeWallet,
  type Harness,
} from "../helpers/harness.js";

let node: MockNode;
let h: Harness;
let wallet: FakeWallet;

const TRANSFER = { to: OTHER, assetId: KMOI, amount: "10" };

beforeEach(async () => {
  node = await startMockNode();
  h = await startHarness(node.url);
  wallet = fakeWallet();
  installWallet(h.home, wallet);
});

afterEach(async () => {
  await h.close();
  await node.close();
});

/** A bigint anywhere in the wallet payload would make the relay's JSON.stringify throw. */
function assertJsonSafe(value: unknown): void {
  expect(() => JSON.stringify(value)).not.toThrow();
}

function signedIx(index = 0): Record<string, unknown> {
  const req = wallet.requests[index];
  expect(req, `expected a wallet request #${index}`).toBeDefined();
  expect(req!.request.method).toBe("moi.signInteraction");
  expect(req!.request.params).toHaveLength(1);
  assertJsonSafe(req!.request.params[0]);
  return req!.request.params[0] as Record<string, unknown>;
}

type Op = { type: number; payload: Record<string, unknown> };

function opsOf(ix: Record<string, unknown>): Op[] {
  return ix["ix_operations"] as Op[];
}

/**
 * The operations the node was asked to DRY-RUN, from the `moi.Call` the
 * simulation guard made. The SDK sends `{ ix_args: toInteractionArgs(ix) }`,
 * so the operations arrive with their payloads POLO-encoded to hex.
 */
function simulatedOps(): Array<{ type: number; payload: string }> {
  const call = node.calls.find((c) => c.method === "moi.Call");
  expect(call, "expected a moi.Call simulation").toBeDefined();
  const args = call!.params["ix_args"] as { ix_operations: Array<{ type: number; payload: string }> };
  return args.ix_operations;
}

describe("guard order", () => {
  it("unpaired → rejected/wallet_disconnected before any node or wallet traffic", async () => {
    const result = await h.call("moi_transfer", TRANSFER);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: "rejected",
      reason: "wallet_disconnected",
    });
    expect(String(result.structuredContent?.["message"])).toMatch(/moi_connect_wallet/);
    expect(wallet.request).not.toHaveBeenCalled();
    expect(node.calls).toHaveLength(0);
  });

  it("session on another network → rejected/network_mismatch", async () => {
    seedSession(h.home, { network: "voyage", chainId: "moi:14" });
    const result = await h.call("moi_transfer", TRANSFER);
    expect(result.structuredContent).toMatchObject({
      status: "rejected",
      reason: "network_mismatch",
    });
    expect(String(result.structuredContent?.["message"])).toMatch(/voyage/);
    expect(wallet.request).not.toHaveBeenCalled();
    expect(node.calls).toHaveLength(0);
  });

  it("expired session → rejected/wallet_disconnected", async () => {
    seedSession(h.home, { expiry: Math.floor(Date.now() / 1000) - 10 });
    const result = await h.call("moi_transfer", TRANSFER);
    expect(result.structuredContent).toMatchObject({
      status: "rejected",
      reason: "wallet_disconnected",
    });
    expect(String(result.structuredContent?.["message"])).toMatch(/expired/i);
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it("insufficient balance → error before any wallet request", async () => {
    seedSession(h.home);
    node.state.kmoiBalance = 5n;

    const result = await h.call("moi_transfer", TRANSFER);
    expect(result.isError).toBe(true);
    // The [CODE] token is the ONLY machine-readable code an agent sees: the
    // SDK's tools/call wrapper drops McpError.data (src/errors.ts).
    expect(result.text).toMatch(/^MCP error -32600: \[INSUFFICIENT_BALANCE\] /);
    expect(result.text).toMatch(/holds 5 of KMOI .* needs 10/);
    expect(wallet.request).not.toHaveBeenCalled();
    // The balance check is the last read; nothing is built, estimated or simulated.
    expect(node.methods()).not.toContain("moi.FuelEstimate");
    expect(node.methods()).not.toContain("moi.Call");
    expect(node.methods()).not.toContain("moi.SendInteractions");
  });

  it("simulation status 1 → refused locally with no wallet request", async () => {
    seedSession(h.home);
    node.state.callStatus = 1;

    const result = await h.call("moi_transfer", TRANSFER);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/would fail \(receipt status 1\)/);
    expect(result.text).toMatch(/approving it would burn fuel/);
    expect(wallet.request).not.toHaveBeenCalled();
    expect(node.methods()).toContain("moi.Call");
    expect(node.methods()).not.toContain("moi.SendInteractions");
  });

  it("node unreachable during simulation → refused, not sent to the phone", async () => {
    seedSession(h.home);
    node.on("moi.Call", () => {
      throw new Error("execution reverted: boom");
    });
    const result = await h.call("moi_transfer", TRANSFER);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/boom/);
    expect(wallet.request).not.toHaveBeenCalled();
  });
});

describe("moi_transfer success path", () => {
  it("signs on the phone, broadcasts from here, returns the hash", async () => {
    seedSession(h.home);

    const result = await h.call("moi_transfer", { ...TRANSFER, memo: "rent" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      status: "sent",
      hash: SENT_HASH,
      explorerUrl: `https://voyage.moi.technology/interaction/?${SENT_HASH}`,
    });
    expect(String(result.structuredContent?.["explorerUrl"])).toContain("/interaction/?");

    // The phone was asked to SIGN (not send), on the session's topic/chain.
    expect(wallet.request).toHaveBeenCalledTimes(1);
    const req = wallet.requests[0]!;
    expect(req.topic).toBe("topic-test");
    expect(req.chainId).toBe("moi:custom");
    const ix = signedIx();
    expect(ix).toMatchObject({
      sender: { id: ACCOUNT, sequence: 5, key_id: 0 },
      fuel_price: 1,
      fuel_limit: Math.ceil(299 * 1.5),
    });
    const ops = opsOf(ix);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.type).toBe(5); // ASSET_INVOKE
    expect(ops[0]!.payload["asset_id"]).toBe(KMOI);
    expect(String(ops[0]!.payload["calldata"])).not.toMatch(/^0x/);

    // HOW MUCH, and TO WHOM. Both are what the human approves on the phone,
    // and without pinning them the tool could move any amount to any account
    // with the suite still green.
    //
    // The participant list the phone receives is NOT the one buildTransfer
    // produced ([recipient, asset]): js-moi-providers normalises the
    // interaction in place during estimateFuel/call, so the sender leads and
    // the recipient trails. Pinned as-is, because this is the list the wallet
    // renders — a change here changes what the user is agreeing to.
    expect(ix["participants"]).toEqual([
      { id: ACCOUNT, lock_type: 0 }, // sender, added by the SDK
      { id: KMOI, lock_type: 2 }, // the asset, MUTATE_LOCK
      { id: OTHER, lock_type: 0 }, // the recipient
    ]);
    // The amount and the beneficiary both live inside the MAS0 calldata:
    // `…"amount" 03 0a "beneficiary" 06 <id>`. Amount 20 would read `0314`.
    expect(ops[0]!.payload["calldata"]).toBe(
      "0d6f06658601b502616d6f756e74030a62656e6566696369617279 06".replace(/ /g, "") +
        OTHER.slice(2),
    );

    // The interaction that was SIMULATED is the interaction that was SIGNED.
    // Without this, assertWillSucceed could dry-run something else entirely
    // and still wave through whatever the phone is asked to approve.
    const simulated = simulatedOps();
    expect(simulated).toHaveLength(ops.length);
    expect(simulated.map((o) => o.type)).toEqual(ops.map((o) => o.type));
    expect(simulated[0]!.payload).toContain(String(ops[0]!.payload["calldata"]));

    // What the phone signed is exactly what the node received. The fake's
    // reply is derived from the interaction it was handed, so this is a real
    // comparison rather than two references to one constant.
    const send = node.calls.find((c) => c.method === "moi.SendInteractions");
    expect(send?.params).toEqual(signatureFor(req));

    // Order: reads → nonce → estimate → simulate → (phone) → broadcast.
    const methods = node.methods();
    expect(methods.indexOf("moi.PendingInteractionCount")).toBeGreaterThan(methods.indexOf("moi.TDU"));
    expect(methods.indexOf("moi.FuelEstimate")).toBeGreaterThan(methods.indexOf("moi.PendingInteractionCount"));
    expect(methods.indexOf("moi.Call")).toBeGreaterThan(methods.indexOf("moi.FuelEstimate"));
    expect(methods.indexOf("moi.SendInteractions")).toBe(methods.length - 1);
  });

  it("uses the pending interaction count as the sequence number", async () => {
    seedSession(h.home);
    node.on("moi.PendingInteractionCount", () => "0x2a");
    await h.call("moi_transfer", TRANSFER);
    expect(signedIx()["sender"]).toMatchObject({ sequence: 42 });
    expect(node.calls.find((c) => c.method === "moi.PendingInteractionCount")?.params).toMatchObject({
      id: ACCOUNT,
      key_id: 0,
    });
  });

  it("falls back to the default fuel ceiling when estimation fails", async () => {
    seedSession(h.home);
    node.on("moi.FuelEstimate", () => {
      throw new Error("estimate unavailable");
    });
    const result = await h.call("moi_transfer", TRANSFER);
    expect(result.structuredContent?.["status"]).toBe("sent");
    expect(signedIx()["fuel_limit"]).toBe(200_000);
  });

  it("rejects an amount with more decimals than the asset's dimension, before any wallet traffic", async () => {
    seedSession(h.home);
    const result = await h.call("moi_transfer", { ...TRANSFER, amount: "1.5" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/dimension is 0/);
    expect(wallet.request).not.toHaveBeenCalled();
  });
});

describe("wallet outcomes map onto the WriteResult union", () => {
  it("phone rejection → rejected/user_rejected", async () => {
    seedSession(h.home);
    wallet.request.mockRejectedValueOnce({ code: 5000, message: "User rejected the request" });

    const result = await h.call("moi_transfer", TRANSFER);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ status: "rejected", reason: "user_rejected" });
    expect(node.methods()).not.toContain("moi.SendInteractions");
  });

  it("phone never answers → rejected/timeout", async () => {
    seedSession(h.home);
    installWallet(h.home, (wallet = fakeWallet(() => new Promise(() => {}))), { requestTimeoutMs: 50 });

    const result = await h.call("moi_transfer", TRANSFER);
    expect(result.structuredContent).toMatchObject({ status: "rejected", reason: "timeout" });
  });

  it("wallet-side serialisation failure is NOT reported as a user rejection", async () => {
    seedSession(h.home);
    wallet.request.mockRejectedValueOnce({ code: 5000, message: "Failed to sign interaction" });

    const result = await h.call("moi_transfer", TRANSFER);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not a rejection/);
  });

  it("broadcast failure after approval is reported as an error, not a rejection", async () => {
    seedSession(h.home);
    node.on("moi.SendInteractions", () => {
      throw new Error("ixpool full");
    });
    const result = await h.call("moi_transfer", TRANSFER);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/approved the interaction but broadcasting it failed/);
  });

  it("REGRESSION: the rejected envelope passes the advertised outputSchema", async () => {
    // Every write tool once advertised only the `sent` variant, so every
    // rejection failed output validation at the server and was surfaced to
    // the agent as a validation error instead of `{status:'rejected'}`.
    const { tools } = await h.client.listTools();
    for (const name of ["moi_transfer", "moi_create_asset"]) {
      const tool = tools.find((t) => t.name === name);
      const schema = tool?.outputSchema as { required?: string[]; properties: Record<string, unknown> };
      expect(schema, `${name} must advertise an output schema`).toBeDefined();
      expect(schema.required ?? []).not.toContain("hash");
      expect(schema.required ?? []).not.toContain("explorerUrl");
      expect(Object.keys(schema.properties)).toEqual(
        expect.arrayContaining(["status", "hash", "explorerUrl", "reason", "message"]),
      );
    }

    // Unpaired: the client validates structuredContent against that schema
    // (listTools ran in the harness) and would throw if it did not match.
    const rejected = await h.call("moi_transfer", TRANSFER);
    expect(rejected.isError).toBeFalsy();
    expect(WriteResult.parse(rejected.structuredContent)).toMatchObject({ status: "rejected" });

    const created = await h.call("moi_create_asset", { symbol: "TST", supply: "100" });
    expect(created.isError).toBeFalsy();
    expect(WriteResult.parse(created.structuredContent)).toMatchObject({
      status: "rejected",
      reason: "wallet_disconnected",
    });
  });
});

describe("moi_create_asset", () => {
  const CREATE = { symbol: "TST", supply: "1000", dimension: 2, standard: "MAS0" };

  it("bundles ASSET_CREATE with a KMOI funding transfer and threads storageFund", async () => {
    seedSession(h.home);

    const a = await h.call("moi_create_asset", { ...CREATE, storageFund: "5000" });
    expect(a.structuredContent).toMatchObject({ status: "sent", hash: SENT_HASH });
    const b = await h.call("moi_create_asset", { ...CREATE, storageFund: "20000" });
    expect(b.structuredContent).toMatchObject({ status: "sent", hash: SENT_HASH });

    const opsA = opsOf(signedIx(0));
    const opsB = opsOf(signedIx(1));
    expect(opsA.map((o) => o.type)).toEqual([4, 5]); // ASSET_CREATE, ASSET_INVOKE
    expect(opsA[0]!.payload).toMatchObject({
      symbol: "TST",
      max_supply: 100_000, // "1000" scaled by dimension 2
      dimension: 2,
      standard: 0,
      manager: ACCOUNT,
    });
    expect(opsA[1]!.payload["asset_id"]).toBe(KMOI);
    // Same create, different fund → identical create leg, different funding
    // calldata. (ASSET_CREATE carries no calldata at all, so compare the whole
    // payload rather than a field that is undefined on both sides.)
    expect(opsA[0]!.payload).toEqual(opsB[0]!.payload);
    expect(opsA[1]!.payload["calldata"]).not.toEqual(opsB[1]!.payload["calldata"]);

    // storageFund is KMOI, and KMOI's dimension is 0 — it must NOT be scaled
    // by the dimension of the asset being created. Same fund, dimension 6:
    // the funding leg has to come out byte-identical. Scaling it there would
    // over-fund by 10^dimension, and the inequality above would still hold.
    const c = await h.call("moi_create_asset", { ...CREATE, dimension: 6, storageFund: "5000" });
    expect(c.structuredContent).toMatchObject({ status: "sent" });
    const opsC = opsOf(signedIx(2));
    expect(opsC[1]!.payload["calldata"]).toEqual(opsA[1]!.payload["calldata"]);
    // Guard the guard: the CREATE leg really does change with the dimension,
    // so the equality above compares two genuinely different interactions.
    expect(opsC[0]!.payload).toMatchObject({ dimension: 6, max_supply: 1_000_000_000 });
  });

  it("default storageFund with a node that reports insufficient → refused locally with the hint", async () => {
    seedSession(h.home);
    node.state.callStatus = 1;

    const result = await h.call("moi_create_asset", CREATE);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/would fail \(receipt status 1\)/);
    expect(result.text).toMatch(/storageFund/);
    expect(result.text).toMatch(/1000000/);
    expect(wallet.request).not.toHaveBeenCalled();
    expect(node.methods()).not.toContain("moi.SendInteractions");
  });

  it("unknown standard is refused before any node traffic past the nonce", async () => {
    seedSession(h.home);
    const result = await h.call("moi_create_asset", { ...CREATE, standard: "MAS9" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Unknown asset standard "MAS9"/);
    expect(wallet.request).not.toHaveBeenCalled();
    expect(node.methods()).not.toContain("moi.FuelEstimate");
  });
});

describe("moi_call_logic", () => {
  it("kind:'view' runs against the node with no session and no wallet request", async () => {
    // Deliberately NOT seeding a session.
    const result = await h.call("moi_call_logic", { logicId: LOGIC, routine: "Ping", kind: "view" });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      routine: "Ping",
      outputs: { output: null, error: null },
    });
    expect(wallet.request).not.toHaveBeenCalled();
    // REGRESSION: the view path must not even CONSTRUCT the wallet client.
    // `request` staying unused is too weak — currentSession() with no session
    // on disk falls through to init() -> the SignClient factory, which in
    // production opens a relay connection and wc.db for a plain read.
    expect(wallet.factory).not.toHaveBeenCalled();
    expect(node.methods()).toEqual(expect.arrayContaining(["moi.LogicManifest", "moi.Call"]));
    expect(node.methods()).not.toContain("moi.SendInteractions");
  });

  it("kind:'view' with an unknown routine names the available ones", async () => {
    const result = await h.call("moi_call_logic", { logicId: LOGIC, routine: "Nope", kind: "view" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/has no routine "Nope"\. Available: Ping/);
  });

  it("kind:'invoke' unpaired → rejected/wallet_disconnected", async () => {
    const result = await h.call("moi_call_logic", { logicId: LOGIC, routine: "Ping" });
    expect(result.structuredContent).toMatchObject({
      status: "rejected",
      reason: "wallet_disconnected",
    });
    expect(wallet.request).not.toHaveBeenCalled();
  });

  it("kind:'invoke' paired → LOGIC_INVOKE signed on the phone and broadcast", async () => {
    seedSession(h.home);
    const result = await h.call("moi_call_logic", { logicId: LOGIC, routine: "Ping", kind: "invoke" });
    expect(result.structuredContent).toMatchObject({ status: "sent", hash: SENT_HASH });

    const ix = signedIx();
    expect(opsOf(ix)).toEqual([{ type: 12, payload: { logic_id: LOGIC, callsite: "Ping" } }]);
    expect(node.calls.find((c) => c.method === "moi.SendInteractions")?.params).toEqual(
      signatureFor(wallet.requests[0]!),
    );
  });
});
