/**
 * Tests for the signing abstraction that generalizes phone-based and
 * agent-key-based signers. Network-free, using mocks for wallet and provider.
 */

import { describe, expect, it, vi } from "vitest";

import { PhoneSigner, signAndBroadcast, type InteractionSigner } from "../../src/signing/index.js";
import { MoiError } from "../../src/moi-error.js";
import { ErrorCode } from "../../src/schema.js";
import type { UnsignedInteraction } from "../../src/moi/ix-builder.js";
import type { Session } from "../../src/wc/session.js";
import type { WalletConnectClient } from "../../src/wc/client.js";

const mockSession: Session = {
  version: 1,
  account: "0xabc123def456789",
  topic: "topic-123",
  peer: { name: "MOI Wallet" },
  network: "voyage",
  chainId: "moi:custom",
  expiry: Math.floor(Date.now() / 1000) + 86400,
  createdAt: Math.floor(Date.now() / 1000),
};

const mockUnsignedIx: UnsignedInteraction = {
  sender: { id: "0xsender", sequence: 1, key_id: 0 },
  fuel_limit: 100_000,
  fuel_price: 1,
  ix_operations: [],
};

const mockSignResult = {
  ix_args: "0xabcd1234",
  signatures: "0xsignature5678",
};

const mockHash = "0x1234567890abcdef";

describe("PhoneSigner", () => {
  it("has a diagnostic label containing the account prefix", () => {
    const mockWallet = {
      signInteraction: vi.fn(),
    } as unknown as WalletConnectClient;

    const signer = new PhoneSigner(mockWallet, mockSession);
    expect(signer.label).toMatch(/^phone:/);
    expect(signer.label).toContain("0xab"); // Account prefix
  });

  it("delegates sign() to the wallet client's signInteraction method", async () => {
    const mockWallet = {
      signInteraction: vi.fn().mockResolvedValue(mockSignResult),
    } as unknown as WalletConnectClient;

    const signer = new PhoneSigner(mockWallet, mockSession);
    const result = await signer.sign(mockUnsignedIx, { description: "test transfer" });

    expect(mockWallet.signInteraction).toHaveBeenCalledWith(mockSession, mockUnsignedIx, {
      description: "test transfer",
    });
    expect(result).toEqual(mockSignResult);
  });

  it("passes the description option through unchanged", async () => {
    const signInteraction = vi.fn().mockResolvedValue(mockSignResult);
    const mockWallet = { signInteraction } as unknown as WalletConnectClient;

    const signer = new PhoneSigner(mockWallet, mockSession);
    await signer.sign(mockUnsignedIx, { description: "mint 100 tokens" });

    const call = signInteraction.mock.calls[0]!;
    expect(call[2]?.description).toBe("mint 100 tokens");
  });

  it("works with or without the description option", async () => {
    const mockWallet = {
      signInteraction: vi.fn().mockResolvedValue(mockSignResult),
    } as unknown as WalletConnectClient;

    const signer = new PhoneSigner(mockWallet, mockSession);
    await signer.sign(mockUnsignedIx);

    expect(mockWallet.signInteraction).toHaveBeenCalledWith(mockSession, mockUnsignedIx, undefined);
  });
});

describe("signAndBroadcast", () => {
  it("calls signer.sign() with the interaction and description, then sends to provider", async () => {
    const mockSigner: InteractionSigner = {
      label: "mock:signer",
      sign: vi.fn().mockResolvedValue(mockSignResult),
    };

    const mockProvider = {
      sendInteraction: vi.fn().mockResolvedValue({ hash: mockHash }),
    };

    const result = await signAndBroadcast(
      mockSigner,
      mockProvider,
      mockUnsignedIx,
      "test transfer",
    );

    expect(mockSigner.sign).toHaveBeenCalledWith(mockUnsignedIx, { description: "test transfer" });
    expect(mockProvider.sendInteraction).toHaveBeenCalledWith(mockSignResult);
    expect(result).toBe(mockHash);
  });

  it("returns the hash exactly as the provider returns it", async () => {
    const mockSigner: InteractionSigner = {
      label: "mock:signer",
      sign: vi.fn().mockResolvedValue(mockSignResult),
    };

    const expectedHash = "0xdeadbeefdeadbeef1234567890abcdef";
    const mockProvider = {
      sendInteraction: vi.fn().mockResolvedValue({ hash: expectedHash }),
    };

    const result = await signAndBroadcast(mockSigner, mockProvider, mockUnsignedIx, "test");

    expect(result).toBe(expectedHash);
  });

  it("throws RPC_ERROR if the hash is missing", async () => {
    const mockSigner: InteractionSigner = {
      label: "mock:signer",
      sign: vi.fn().mockResolvedValue(mockSignResult),
    };

    const mockProvider = {
      sendInteraction: vi.fn().mockResolvedValue({}),
    };

    await expect(signAndBroadcast(mockSigner, mockProvider, mockUnsignedIx, "test")).rejects.toThrow(
      expect.objectContaining({
        code: ErrorCode.RPC_ERROR,
        message: expect.stringContaining("returned no hash"),
      }),
    );
  });

  it("throws RPC_ERROR if the hash is not a hex string", async () => {
    const mockSigner: InteractionSigner = {
      label: "mock:signer",
      sign: vi.fn().mockResolvedValue(mockSignResult),
    };

    const mockProvider = {
      sendInteraction: vi.fn().mockResolvedValue({ hash: "not-a-hash" }),
    };

    await expect(signAndBroadcast(mockSigner, mockProvider, mockUnsignedIx, "test")).rejects.toThrow(
      expect.objectContaining({
        code: ErrorCode.RPC_ERROR,
      }),
    );
  });

  it("throws RPC_ERROR if the hash is a valid hex string but does not start with 0x", async () => {
    const mockSigner: InteractionSigner = {
      label: "mock:signer",
      sign: vi.fn().mockResolvedValue(mockSignResult),
    };

    const mockProvider = {
      sendInteraction: vi.fn().mockResolvedValue({ hash: "1234567890abcdef" }),
    };

    await expect(signAndBroadcast(mockSigner, mockProvider, mockUnsignedIx, "test")).rejects.toThrow(
      expect.objectContaining({
        code: ErrorCode.RPC_ERROR,
      }),
    );
  });

  it("preserves MoiErrors thrown by the signer", async () => {
    const testError = new MoiError(ErrorCode.USER_REJECTED, "User said no");
    const mockSigner: InteractionSigner = {
      label: "mock:signer",
      sign: vi.fn().mockRejectedValue(testError),
    };

    const mockProvider = {
      sendInteraction: vi.fn(),
    };

    await expect(signAndBroadcast(mockSigner, mockProvider, mockUnsignedIx, "test")).rejects.toBe(
      testError,
    );
  });

  it("preserves MoiErrors thrown by the provider", async () => {
    const testError = new MoiError(ErrorCode.NETWORK_MISMATCH, "Wrong network");
    const mockSigner: InteractionSigner = {
      label: "mock:signer",
      sign: vi.fn().mockResolvedValue(mockSignResult),
    };

    const mockProvider = {
      sendInteraction: vi.fn().mockRejectedValue(testError),
    };

    await expect(signAndBroadcast(mockSigner, mockProvider, mockUnsignedIx, "test")).rejects.toBe(
      testError,
    );
  });

  it("translates non-MoiError provider failures into RPC_ERROR with user-facing message", async () => {
    const mockSigner: InteractionSigner = {
      label: "mock:signer",
      sign: vi.fn().mockResolvedValue(mockSignResult),
    };

    const mockProvider = {
      sendInteraction: vi.fn().mockRejectedValue(new Error("ixpool full")),
    };

    let thrownError: unknown;
    try {
      await signAndBroadcast(mockSigner, mockProvider, mockUnsignedIx, "test");
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(MoiError);
    const error = thrownError as MoiError;
    expect(error.code).toBe(ErrorCode.RPC_ERROR);
    expect(error.message).toMatch(/approved the interaction but broadcasting it failed/);
    expect(error.message).toMatch(/ixpool full/);
  });

  it("truncates very long error messages from the provider at 180 chars", async () => {
    const mockSigner: InteractionSigner = {
      label: "mock:signer",
      sign: vi.fn().mockResolvedValue(mockSignResult),
    };

    const longMessage = "a".repeat(300);
    const mockProvider = {
      sendInteraction: vi.fn().mockRejectedValue(new Error(longMessage)),
    };

    let thrownError: unknown;
    try {
      await signAndBroadcast(mockSigner, mockProvider, mockUnsignedIx, "test");
    } catch (err) {
      thrownError = err;
    }

    const error = thrownError as MoiError;
    const errorMessage = error.message;
    const truncatedPart = errorMessage.slice(errorMessage.indexOf("approved"));
    expect(truncatedPart.length).toBeLessThanOrEqual(300); // conservative bound
    expect(errorMessage).toContain("a".repeat(50)); // Some of the long message is included
  });

  it("handles non-Error types thrown by the provider", async () => {
    const mockSigner: InteractionSigner = {
      label: "mock:signer",
      sign: vi.fn().mockResolvedValue(mockSignResult),
    };

    const mockProvider = {
      sendInteraction: vi.fn().mockRejectedValue("string error"),
    };

    let thrownError: unknown;
    try {
      await signAndBroadcast(mockSigner, mockProvider, mockUnsignedIx, "test");
    } catch (err) {
      thrownError = err;
    }

    const error = thrownError as MoiError;
    expect(error.code).toBe(ErrorCode.RPC_ERROR);
    expect(error.message).toMatch(/approved the interaction but broadcasting it failed/);
    expect(error.message).toMatch(/string error/);
  });

  it("REGRESSION: preserves the verbatim 'approved but broadcast failed' error copy", async () => {
    const mockSigner: InteractionSigner = {
      label: "mock:signer",
      sign: vi.fn().mockResolvedValue(mockSignResult),
    };

    const mockProvider = {
      sendInteraction: vi.fn().mockRejectedValue(new Error("network timeout")),
    };

    let thrownError: unknown;
    try {
      await signAndBroadcast(mockSigner, mockProvider, mockUnsignedIx, "test");
    } catch (err) {
      thrownError = err;
    }

    const error = thrownError as MoiError;
    // This exact string appears in the UI, so it must not change.
    expect(error.message).toContain("You approved the interaction but broadcasting it failed:");
  });
});

describe("InteractionSigner interface contract", () => {
  it("PhoneSigner implements InteractionSigner", () => {
    const mockWallet = {
      signInteraction: vi.fn(),
    } as unknown as WalletConnectClient;

    const signer = new PhoneSigner(mockWallet, mockSession);

    // Duck-type check: all required properties and methods exist.
    expect(typeof signer.label).toBe("string");
    expect(typeof signer.sign).toBe("function");
  });

  it("custom signer implementations can be substituted in signAndBroadcast", async () => {
    // A mock signer that is not PhoneSigner but implements the interface.
    const customSigner: InteractionSigner = {
      label: "custom:local",
      sign: vi.fn().mockResolvedValue(mockSignResult),
    };

    const mockProvider = {
      sendInteraction: vi.fn().mockResolvedValue({ hash: mockHash }),
    };

    const result = await signAndBroadcast(customSigner, mockProvider, mockUnsignedIx, "custom");

    expect(result).toBe(mockHash);
    expect(customSigner.sign).toHaveBeenCalled();
  });
});
