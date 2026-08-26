import {
  AssetStandard,
  createParticipantId,
  deriveAssetId,
  LockType,
  OpType,
  ParticipantTagV0,
} from "js-moi-sdk";
import { describe, expect, it } from "vitest";

import {
  assertSendable,
  buildCreateAsset,
  estimateFuelFor,
  buildLogicInvoke,
  buildTransfer,
  MAX_OPERATIONS,
  parseAmount,
  toPoloHex,
  toWireJson,
  type SenderInfo,
} from "../../src/moi/ix-builder.js";
import { MoiError } from "../../src/moi-error.js";

const sender = createParticipantId({ fingerprint: new Uint8Array(24).fill(7), variant: 0, tag: ParticipantTagV0 });
const recipient = createParticipantId({ fingerprint: new Uint8Array(24).fill(9), variant: 0, tag: ParticipantTagV0 });
const asset = deriveAssetId({ id: sender.toHex(), sequence: 0, key_id: 0 }, AssetStandard.MAS0);

const SENDER: SenderInfo = { id: sender.toHex(), sequence: 3, keyId: 0 };

describe("parseAmount", () => {
  it("scales into base units", () => {
    expect(parseAmount("1.5", 6)).toBe(1_500_000n);
    expect(parseAmount("1", 18)).toBe(10n ** 18n);
    expect(parseAmount("0", 6)).toBe(0n);
    expect(parseAmount("42", 0)).toBe(42n);
  });

  it("round-trips exactly past the float53 boundary", () => {
    expect(parseAmount("1180.591620717411303424", 18)).toBe(2n ** 70n);
  });

  it("refuses more decimal places than the asset has", () => {
    expect(() => parseAmount("1.1234567", 6)).toThrow(/dimension is 6/);
  });

  it("refuses non-decimal input rather than coercing it", () => {
    for (const bad of ["1e6", "-1", "abc", "", "0x10", "1.2.3"]) {
      expect(() => parseAmount(bad, 6)).toThrow(MoiError);
    }
  });
});

describe("buildTransfer", () => {
  const ix = buildTransfer(SENDER, { to: recipient.toHex(), assetId: asset.toHex(), amount: 1000n });

  it("carries the sender's sequence so the wallet does not have to guess", () => {
    expect(ix.sender).toEqual({ id: sender.toHex(), sequence: 3, key_id: 0 });
  });

  it("emits a single ASSET_INVOKE operation", () => {
    expect(ix.ix_operations).toHaveLength(1);
    expect(ix.ix_operations[0]!.type).toBe(OpType.ASSET_INVOKE);
    expect(ix.ix_operations[0]!.payload["callsite"]).toBe("Transfer");
  });

  it("declares the recipient as a mutating participant", () => {
    // MOI sandboxes state: an account not declared here cannot be touched.
    expect(ix.participants).toEqual([
      { id: recipient.toHex(), lock_type: LockType.MUTATE_LOCK, notary: false },
    ]);
  });

  it("declares the funds moved, as bigint not string", () => {
    expect(ix.funds).toEqual([{ asset_id: asset.toHex(), amount: 1000n }]);
  });
});

describe("buildCreateAsset", () => {
  it("maps the standard name onto its numeric code", () => {
    const ix = buildCreateAsset(SENDER, {
      symbol: "TEST", supply: 1000n, dimension: 2, standard: "MAS0", isStateful: false, isFungible: true,
    });
    expect(ix.ix_operations[0]!.type).toBe(OpType.ASSET_CREATE);
    expect(ix.ix_operations[0]!.payload["standard"]).toBe(AssetStandard.MAS0);
    expect(ix.ix_operations[0]!.payload["manager"]).toBe(sender.toHex());
    // max_supply must be bigint, and there is no `supply` field in
    // AssetCreatePayload — a string here fails POLO inside the wallet.
    expect(typeof ix.ix_operations[0]!.payload["max_supply"]).toBe("bigint");
    expect(ix.ix_operations[0]!.payload).not.toHaveProperty("supply");
  });

  it("rejects an unknown standard", () => {
    expect(() =>
      buildCreateAsset(SENDER, {
        symbol: "X", supply: 1n, dimension: 0, standard: "MAS9", isStateful: false, isFungible: true,
      }),
    ).toThrow(/MAS0, MAS1, MAS2, MASX/);
  });
});

describe("buildLogicInvoke", () => {
  it("emits LOGIC_INVOKE with the callsite", () => {
    const ix = buildLogicInvoke(SENDER, { logicId: "0xabc", callsite: "Increment", calldata: "0x0d5f" });
    expect(ix.ix_operations[0]!.type).toBe(OpType.LOGIC_INVOKE);
    expect(ix.ix_operations[0]!.payload).toMatchObject({
      logic_id: "0xabc", callsite: "Increment", calldata: "0x0d5f",
    });
  });

  it("omits calldata entirely for a no-argument routine", () => {
    const ix = buildLogicInvoke(SENDER, { logicId: "0xabc", callsite: "Ping" });
    expect(ix.ix_operations[0]!.payload).not.toHaveProperty("calldata");
  });
});

describe("assertSendable", () => {
  const ix = buildTransfer(SENDER, { to: recipient.toHex(), assetId: asset.toHex(), amount: 1n });

  it("accepts a normal interaction", () => {
    expect(() => assertSendable(ix)).not.toThrow();
  });

  it("rejects an empty interaction", () => {
    expect(() => assertSendable({ ...ix, ix_operations: [] })).toThrow(/no operations/);
  });

  it("rejects more operations than the node allows", () => {
    const tooMany = Array.from({ length: MAX_OPERATIONS + 1 }, () => ix.ix_operations[0]!);
    expect(() => assertSendable({ ...ix, ix_operations: tooMany })).toThrow(/at most 3/);
  });
});

describe("toPoloHex", () => {
  it("POLO-encodes without any key material", () => {
    const hex = toPoloHex(buildTransfer(SENDER, { to: recipient.toHex(), assetId: asset.toHex(), amount: 1000n }));
    // Deliberately UNPREFIXED. js-moi-wallet emits `ix_args: bytesToHex(...)`,
    // and the documented node payload is likewise bare hex
    // ("0e9f020ef604f3088309a009..."). Adding 0x here would break the wallet.
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(hex.startsWith("0x")).toBe(false);
    expect(hex.length).toBeGreaterThan(100);
    // POLO documents are self-describing and start with a wire-type header.
    expect(hex.startsWith("0e")).toBe(true);
  });

  it("is deterministic — the same interaction encodes identically", () => {
    const make = () => buildTransfer(SENDER, { to: recipient.toHex(), assetId: asset.toHex(), amount: 1000n });
    expect(toPoloHex(make())).toBe(toPoloHex(make()));
  });

  it("changes when the amount changes", () => {
    const a = toPoloHex(buildTransfer(SENDER, { to: recipient.toHex(), assetId: asset.toHex(), amount: 1000n }));
    const b = toPoloHex(buildTransfer(SENDER, { to: recipient.toHex(), assetId: asset.toHex(), amount: 1001n }));
    expect(a).not.toBe(b);
  });
});


describe("every builder POLO-encodes", () => {
  /**
   * Regression for a live failure: buildCreateAsset emitted max_supply as a
   * decimal string plus a bogus `supply` field. POLO rejected it inside MOI
   * Wallet, which surfaced as "Failed to sign interaction" on the phone —
   * js-moi-sdk's own throw string, since the wallet uses the SDK internally.
   *
   * The old tests only POLO-encoded transfers, so nothing caught it. Encoding
   * is the contract with the wallet: every builder must pass.
   */
  const REGISTRY = "0x20000000c684f926ed158d0cbfe66af0e482a389393e7899a5a73fcb00000000";

  const builders: Array<[string, () => ReturnType<typeof buildTransfer>]> = [
    ["transfer", () => buildTransfer(SENDER, { to: recipient.toHex(), assetId: asset.toHex(), amount: 1000n })],
    ["createAsset", () => buildCreateAsset(SENDER, {
      symbol: "MCPTEST", supply: 1000n, dimension: 0, standard: "MAS0", isStateful: false, isFungible: true,
    })],
    ["logicInvoke", () => buildLogicInvoke(SENDER, { logicId: REGISTRY, callsite: "GetAgentCount" })],
  ];

  for (const [name, make] of builders) {
    it(`${name} produces valid POLO bytes`, () => {
      const hex = toPoloHex(make());
      expect(hex).toMatch(/^[0-9a-f]+$/);
      expect(hex.length).toBeGreaterThan(50);
    });
  }
});

describe("estimateFuelFor", () => {
  it("applies headroom to a measured estimate", async () => {
    const r = await estimateFuelFor({ estimateFuel: async () => 299 }, {} as never);
    expect(r).toEqual({ fuelLimit: Math.ceil(299 * 1.5), estimated: true });
  });

  it("falls back when the node cannot simulate, and says why", async () => {
    const r = await estimateFuelFor(
      { estimateFuel: async () => { throw new Error("ReceiptStateReverted"); } }, {} as never,
    );
    expect(r.estimated).toBe(false);
    expect(r.fuelLimit).toBe(200_000);
    expect(r.reason).toMatch(/Reverted/);
  });

  it("falls back on a nonsense estimate rather than sending fuel_limit 0", async () => {
    for (const bad of [0, -1, Number.NaN]) {
      const r = await estimateFuelFor({ estimateFuel: async () => bad }, {} as never);
      expect(r.estimated).toBe(false);
      expect(r.fuelLimit).toBe(200_000);
    }
  });
});

describe("toWireJson — the bigint/JSON boundary", () => {
  /**
   * Regression for a live failure. POLO requires number|bigint for amounts,
   * but the WalletConnect transport is JSON and JSON.stringify throws on
   * bigint — the relay surfaced it only as an opaque request failure.
   */
  it("survives JSON.stringify, which the raw interaction does not", () => {
    const ix = buildCreateAsset(SENDER, {
      symbol: "MCPTEST", supply: 1000n, dimension: 0, standard: "MAS0", isStateful: false, isFungible: true,
    });
    expect(() => JSON.stringify(ix)).toThrow(/BigInt/);
    expect(() => JSON.stringify(toWireJson(ix))).not.toThrow();
  });

  it("keeps safe integers as numbers", () => {
    const ix = buildCreateAsset(SENDER, {
      symbol: "T", supply: 1000n, dimension: 0, standard: "MAS0", isStateful: false, isFungible: true,
    });
    const ops = toWireJson(ix)["ix_operations"] as Array<{ payload: Record<string, unknown> }>;
    expect(ops[0]!.payload["max_supply"]).toBe(1000);
  });

  it("promotes past-2^53 values to strings instead of losing precision", () => {
    const ix = buildCreateAsset(SENDER, {
      symbol: "BIG", supply: 2n ** 70n, dimension: 0, standard: "MAS0", isStateful: false, isFungible: true,
    });
    const ops = toWireJson(ix)["ix_operations"] as Array<{ payload: Record<string, unknown> }>;
    expect(ops[0]!.payload["max_supply"]).toBe("1180591620717411303424");
  });

  it("converts fund amounts too", () => {
    const ix = buildTransfer(SENDER, { to: recipient.toHex(), assetId: asset.toHex(), amount: 1000n });
    const funds = toWireJson(ix)["funds"] as Array<{ amount: unknown }>;
    expect(funds[0]!.amount).toBe(1000);
  });

  it("leaves POLO encoding untouched — it still needs the bigint", () => {
    const ix = buildTransfer(SENDER, { to: recipient.toHex(), assetId: asset.toHex(), amount: 1000n });
    expect(() => toPoloHex(ix)).not.toThrow();
  });
});
