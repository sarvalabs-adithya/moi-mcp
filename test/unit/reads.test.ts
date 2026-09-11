import { AssetStandard, createParticipantId, deriveAssetId, ParticipantTagV0 } from "js-moi-sdk";
import { describe, expect, it } from "vitest";

import { assetStandardName, normalizeAmount, opTypeName, senderId, toBigInt } from "../../src/moi/reads.js";

const participant = createParticipantId({
  fingerprint: new Uint8Array(24).fill(7),
  variant: 0,
  tag: ParticipantTagV0,
});

function assetIdFor(standard: number): string {
  return deriveAssetId({ id: participant.toHex(), sequence: 0, key_id: 0 }, standard).toHex();
}

describe("toBigInt", () => {
  it("reads the hex quantities the MOI RPC actually returns", () => {
    expect(toBigInt("0x1e")).toBe(30n);
    expect(toBigInt("0x0")).toBe(0n);
  });

  it("reads decimal strings, numbers and bigints", () => {
    expect(toBigInt("42")).toBe(42n);
    expect(toBigInt(42)).toBe(42n);
    expect(toBigInt(42n)).toBe(42n);
  });

  it("treats empty and malformed values as zero rather than throwing mid-read", () => {
    expect(toBigInt("")).toBe(0n);
    expect(toBigInt("not-a-number")).toBe(0n);
    expect(toBigInt(undefined)).toBe(0n);
    expect(toBigInt(null)).toBe(0n);
  });
});

describe("normalizeAmount", () => {
  it("dimension 0 leaves the integer untouched", () => {
    expect(normalizeAmount(1500n, 0)).toBe("1500");
    expect(normalizeAmount("0x1e", 0)).toBe("30");
  });

  it("dimension 6 scales and trims trailing zeros", () => {
    expect(normalizeAmount(1_234n, 6)).toBe("0.001234");
    expect(normalizeAmount(1_000_000n, 6)).toBe("1");
    expect(normalizeAmount(1_500_000n, 6)).toBe("1.5");
    expect(normalizeAmount(0n, 6)).toBe("0");
  });

  it("dimension 18 stays exact past the float53 boundary", () => {
    // 2^70 would lose precision as a double; this must be exact.
    expect(normalizeAmount((2n ** 70n).toString(), 18)).toBe("1180.591620717411303424");
    expect(normalizeAmount(10n ** 18n, 18)).toBe("1");
    expect(normalizeAmount(10n ** 18n + 1n, 18)).toBe("1.000000000000000001");
  });

  it("always satisfies the schema Amount regex", () => {
    const AMOUNT = /^\d+(\.\d+)?$/;
    for (const [raw, dim] of [
      [0n, 0],
      [1n, 18],
      [10n ** 18n, 18],
      [123456789n, 6],
      [(2n ** 64n).toString(), 12],
    ] as const) {
      expect(normalizeAmount(raw, dim)).toMatch(AMOUNT);
    }
  });

  it("guards against a nonsense dimension instead of producing NaN", () => {
    expect(normalizeAmount(100n, Number.NaN)).toBe("100");
    expect(normalizeAmount(100n, -5)).toBe("100");
  });
});

describe("assetStandardName", () => {
  it("decodes the standard out of the asset identifier itself", () => {
    expect(assetStandardName(assetIdFor(AssetStandard.MAS0))).toBe("MAS0");
    expect(assetStandardName(assetIdFor(AssetStandard.MAS1))).toBe("MAS1");
    expect(assetStandardName(assetIdFor(AssetStandard.MAS2))).toBe("MAS2");
  });

  it("returns empty string for something that is not an asset id", () => {
    expect(assetStandardName("0xdeadbeef")).toBe("");
  });
});

describe("interaction rendering", () => {
  it("names the operation type instead of emitting a bare enum value", () => {
    // An agent can act on "ASSET_INVOKE"; "5" tells it nothing.
    expect(opTypeName(5)).toBe("ASSET_INVOKE");
    expect(opTypeName("0x5")).toBe("ASSET_INVOKE");
    expect(opTypeName(4)).toBe("ASSET_CREATE");
    expect(opTypeName(12)).toBe("LOGIC_INVOKE");
  });

  it("falls back to the raw value for an unknown op", () => {
    expect(opTypeName(999)).toBe("999");
    expect(opTypeName(undefined)).toBe("unknown");
  });

  it("extracts the participant id from a sender object", () => {
    // Regression: the interaction's `sender` is an object, and stringifying it
    // produced the literal "[object Object]" in tool output.
    expect(senderId({ id: "0xabc", sequence: 1, key_id: 0 })).toBe("0xabc");
    expect(senderId("0xdef")).toBe("0xdef");
    expect(senderId({ id: { toHex: () => "0x123" } })).toBe("0x123");
  });

  it("degrades to 0x0 rather than emitting garbage", () => {
    expect(senderId(undefined)).toBe("0x0");
    expect(senderId({})).toBe("0x0");
  });
});
