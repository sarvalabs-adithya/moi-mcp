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
  buildLogicInvoke,
  buildTransfer,
  MAX_OPERATIONS,
  parseAmount,
  toPoloHex,
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

  it("declares the funds moved", () => {
    expect(ix.funds).toEqual([{ asset_id: asset.toHex(), amount: "1000" }]);
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
