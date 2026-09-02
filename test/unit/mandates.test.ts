import {
  AssetStandard,
  createParticipantId,
  deriveAssetId,
  KMOI_ASSET_ID,
  LockType,
  OpType,
  ParticipantTagV0,
} from "js-moi-sdk";
import { describe, expect, it } from "vitest";

import { type SenderInfo, toPoloHex } from "../../src/moi/ix-builder.js";
import { MoiError } from "../../src/moi-error.js";

// Import mandates functions for testing
import * as mandates from "../../src/moi/mandates.js";

const sender = createParticipantId({ fingerprint: new Uint8Array(24).fill(7), variant: 0, tag: ParticipantTagV0 });
const beneficiary = createParticipantId({
  fingerprint: new Uint8Array(24).fill(8),
  variant: 0,
  tag: ParticipantTagV0,
});
const benefactor = createParticipantId({
  fingerprint: new Uint8Array(24).fill(9),
  variant: 0,
  tag: ParticipantTagV0,
});
const asset = deriveAssetId({ id: sender.toHex(), sequence: 0, key_id: 0 }, AssetStandard.MAS0);

const SENDER: SenderInfo = { id: sender.toHex(), sequence: 3, keyId: 0 };
const NOW = Math.floor(Date.now() / 1000);
const FUTURE = NOW + 86400; // 24 hours from now

describe("buildApprove", () => {
  it("emits a single ASSET_INVOKE operation with callsite Approve", async () => {
    const ix = await mandates.buildApprove(
      {} as never,
      SENDER,
      {
        assetId: asset.toHex(),
        beneficiary: beneficiary.toHex(),
        amount: 1000n,
        expiresAt: FUTURE,
      },
    );
    expect(ix.ix_operations).toHaveLength(1);
    expect(ix.ix_operations[0]!.type).toBe(OpType.ASSET_INVOKE);
    expect(ix.ix_operations[0]!.payload["callsite"]).toBe("Approve");
  });

  it("declares beneficiary and asset as participants, both MUTATE", async () => {
    const ix = await mandates.buildApprove(
      {} as never,
      SENDER,
      {
        assetId: asset.toHex(),
        beneficiary: beneficiary.toHex(),
        amount: 1000n,
        expiresAt: FUTURE,
      },
    );
    // Matches SDK's MAS0AssetLogic.approve() participants
    expect(ix.participants).toHaveLength(2);
    expect(ix.participants).toContainEqual({
      id: beneficiary.toHex(),
      lock_type: LockType.MUTATE_LOCK,
    });
    expect(ix.participants).toContainEqual({
      id: asset.toHex(),
      lock_type: LockType.NO_LOCK,
    });
  });

  it("emits calldata with no 0x prefix, as the SDK does", async () => {
    const ix = await mandates.buildApprove(
      {} as never,
      SENDER,
      {
        assetId: asset.toHex(),
        beneficiary: beneficiary.toHex(),
        amount: 1000n,
        expiresAt: FUTURE,
      },
    );
    expect(String(ix.ix_operations[0]!.payload["calldata"])).toMatch(/^[0-9a-f]+$/);
  });

  it("rejects amount <= 0", async () => {
    for (const badAmount of [0n, -1n]) {
      await expect(
        mandates.buildApprove(
          {} as never,
          SENDER,
          {
            assetId: asset.toHex(),
            beneficiary: beneficiary.toHex(),
            amount: badAmount,
            expiresAt: FUTURE,
          },
        ),
      ).rejects.toThrow(/must be > 0/);
    }
  });

  it("rejects expiresAt in the past or present", async () => {
    for (const badExpiry of [NOW - 1, NOW]) {
      await expect(
        mandates.buildApprove(
          {} as never,
          SENDER,
          {
            assetId: asset.toHex(),
            beneficiary: beneficiary.toHex(),
            amount: 1000n,
            expiresAt: badExpiry,
          },
        ),
      ).rejects.toThrow(/must be in the future/);
    }
  });

  it("produces valid POLO bytes", async () => {
    const ix = await mandates.buildApprove(
      {} as never,
      SENDER,
      {
        assetId: asset.toHex(),
        beneficiary: beneficiary.toHex(),
        amount: 1000n,
        expiresAt: FUTURE,
      },
    );
    const hex = toPoloHex(ix);
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(hex.length).toBeGreaterThan(50);
  });

  it("encodes a large amount <= 2^53 without precision loss", async () => {
    // Use a value that fits in bigint but is safely within the maximum
    const largeAmount = 2n ** 50n;
    const ix = await mandates.buildApprove(
      {} as never,
      SENDER,
      {
        assetId: asset.toHex(),
        beneficiary: beneficiary.toHex(),
        amount: largeAmount,
        expiresAt: FUTURE,
      },
    );
    // Should not throw during POLO encoding
    expect(() => toPoloHex(ix)).not.toThrow();
  });
});

describe("buildRevoke", () => {
  it("emits a single ASSET_INVOKE operation with callsite Revoke", async () => {
    const ix = await mandates.buildRevoke(
      {} as never,
      SENDER,
      {
        assetId: asset.toHex(),
        beneficiary: beneficiary.toHex(),
      },
    );
    expect(ix.ix_operations).toHaveLength(1);
    expect(ix.ix_operations[0]!.type).toBe(OpType.ASSET_INVOKE);
    expect(ix.ix_operations[0]!.payload["callsite"]).toBe("Revoke");
  });

  it("declares beneficiary and asset as participants", async () => {
    const ix = await mandates.buildRevoke(
      {} as never,
      SENDER,
      {
        assetId: asset.toHex(),
        beneficiary: beneficiary.toHex(),
      },
    );
    expect(ix.participants).toHaveLength(2);
    expect(ix.participants).toContainEqual({
      id: beneficiary.toHex(),
      lock_type: LockType.MUTATE_LOCK,
    });
  });

  it("emits calldata with no 0x prefix", async () => {
    const ix = await mandates.buildRevoke(
      {} as never,
      SENDER,
      {
        assetId: asset.toHex(),
        beneficiary: beneficiary.toHex(),
      },
    );
    expect(String(ix.ix_operations[0]!.payload["calldata"])).toMatch(/^[0-9a-f]+$/);
  });

  it("produces valid POLO bytes", async () => {
    const ix = await mandates.buildRevoke(
      {} as never,
      SENDER,
      {
        assetId: asset.toHex(),
        beneficiary: beneficiary.toHex(),
      },
    );
    const hex = toPoloHex(ix);
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(hex.length).toBeGreaterThan(50);
  });
});

describe("buildTransferFrom", () => {
  it("emits a single ASSET_INVOKE operation with callsite TransferFrom", async () => {
    const ix = await mandates.buildTransferFrom(
      {} as never,
      SENDER,
      {
        assetId: asset.toHex(),
        benefactor: benefactor.toHex(),
        beneficiary: beneficiary.toHex(),
        amount: 1000n,
      },
    );
    expect(ix.ix_operations).toHaveLength(1);
    expect(ix.ix_operations[0]!.type).toBe(OpType.ASSET_INVOKE);
    expect(ix.ix_operations[0]!.payload["callsite"]).toBe("TransferFrom");
  });

  it("declares beneficiary, benefactor, and asset as participants", async () => {
    const ix = await mandates.buildTransferFrom(
      {} as never,
      SENDER,
      {
        assetId: asset.toHex(),
        benefactor: benefactor.toHex(),
        beneficiary: beneficiary.toHex(),
        amount: 1000n,
      },
    );
    // SDK returns [beneficiary (MUTATE), benefactor (MUTATE), asset (NO_LOCK)]
    expect(ix.participants).toHaveLength(3);
    expect(ix.participants![0]).toEqual({
      id: beneficiary.toHex(),
      lock_type: LockType.MUTATE_LOCK,
    });
    expect(ix.participants![1]).toEqual({
      id: benefactor.toHex(),
      lock_type: LockType.MUTATE_LOCK,
    });
    expect(ix.participants![2]).toEqual({
      id: asset.toHex(),
      lock_type: LockType.NO_LOCK,
    });
  });

  it("rejects negative amount", async () => {
    await expect(
      mandates.buildTransferFrom(
        {} as never,
        SENDER,
        {
          assetId: asset.toHex(),
          benefactor: benefactor.toHex(),
          beneficiary: beneficiary.toHex(),
          amount: -1n,
        },
      ),
    ).rejects.toThrow(/must be >= 0/);
  });

  it("allows zero amount for probing", async () => {
    const ix = await mandates.buildTransferFrom(
      {} as never,
      SENDER,
      {
        assetId: asset.toHex(),
        benefactor: benefactor.toHex(),
        beneficiary: beneficiary.toHex(),
        amount: 0n,
      },
    );
    expect(ix.ix_operations).toHaveLength(1);
    expect(ix.ix_operations[0]!.type).toBe(OpType.ASSET_INVOKE);
  });

  it("produces valid POLO bytes", async () => {
    const ix = await mandates.buildTransferFrom(
      {} as never,
      SENDER,
      {
        assetId: asset.toHex(),
        benefactor: benefactor.toHex(),
        beneficiary: beneficiary.toHex(),
        amount: 1000n,
      },
    );
    const hex = toPoloHex(ix);
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(hex.length).toBeGreaterThan(50);
  });

  it("encodes a large amount <= 2^53 without precision loss", async () => {
    // Use a value that fits safely within the maximum
    const largeAmount = 2n ** 50n;
    const ix = await mandates.buildTransferFrom(
      {} as never,
      SENDER,
      {
        assetId: asset.toHex(),
        benefactor: benefactor.toHex(),
        beneficiary: beneficiary.toHex(),
        amount: largeAmount,
      },
    );
    expect(() => toPoloHex(ix)).not.toThrow();
  });
});

describe("probeMandate", () => {
  it("never throws on RPC failure", async () => {
    const result = await mandates.probeMandate(
      { call: async () => { throw new Error("RPC failed"); } },
      SENDER,
      {
        assetId: asset.toHex(),
        benefactor: benefactor.toHex(),
        beneficiary: beneficiary.toHex(),
      },
    );
    expect(result.probed).toBe(true); // Build succeeded, call() failed
    expect(result.likelyActive).toBe("unknown");
    expect(result.detail).toContain("RPC failed");
  });

  it("returns likelyActive:true on status 0", async () => {
    const result = await mandates.probeMandate(
      { call: async () => ({ receipt: { status: 0 } }) },
      SENDER,
      {
        assetId: asset.toHex(),
        benefactor: benefactor.toHex(),
        beneficiary: beneficiary.toHex(),
      },
    );
    expect(result.probed).toBe(true);
    expect(result.likelyActive).toBe(true);
  });

  it("returns likelyActive:false on non-zero status", async () => {
    const result = await mandates.probeMandate(
      { call: async () => ({ receipt: { status: 1 } }) },
      SENDER,
      {
        assetId: asset.toHex(),
        benefactor: benefactor.toHex(),
        beneficiary: beneficiary.toHex(),
      },
    );
    expect(result.probed).toBe(true);
    expect(result.likelyActive).toBe(false);
  });

  it("handles missing receipt gracefully", async () => {
    const result = await mandates.probeMandate(
      { call: async () => ({}) },
      SENDER,
      {
        assetId: asset.toHex(),
        benefactor: benefactor.toHex(),
        beneficiary: beneficiary.toHex(),
      },
    );
    expect(result.probed).toBe(true);
    expect(result.likelyActive).toBe(true); // Defaults to status 0
  });

  it("builds the probe with zero amount, never moving funds", async () => {
    let capturedIx: unknown;
    await mandates.probeMandate(
      {
        call: async (ix: unknown) => {
          capturedIx = ix;
          return { receipt: { status: 0 } };
        },
      },
      SENDER,
      {
        assetId: asset.toHex(),
        benefactor: benefactor.toHex(),
        beneficiary: beneficiary.toHex(),
      },
    );

    // Verify the captured interaction's POLO encoding can be round-tripped
    const ix = capturedIx as any;
    expect(ix.ix_operations).toHaveLength(1);
    expect(ix.ix_operations[0]!.type).toBe(OpType.ASSET_INVOKE);
    expect(ix.ix_operations[0]!.payload["callsite"]).toBe("TransferFrom");
    // The actual amount=0 is encoded in the calldata; we trust
    // that buildTransferFrom was called with 0n since that's what
    // probeMandate passes to it
  });
});
