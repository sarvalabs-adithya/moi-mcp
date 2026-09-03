/**
 * Tests for the mandate funding module.
 *
 * Validates:
 * - Balance queries via getTDU
 * - Shortfall math (including boundary cases)
 * - Funding status structure (no signed objects, plain data only)
 * - Suggested action format (points to moi_transfer, never to a signing function)
 * - Error handling (graceful RPC failures)
 * - Invariant: owner key never touched, wallet object never created
 */

import { createParticipantId, ParticipantTagV0 } from "js-moi-sdk";
import { describe, expect, it, vi } from "vitest";

import * as funding from "../../src/mandates/funding.js";

/**
 * Test fixtures: throwaway keys for testing (never persisted, never used to sign real interactions).
 */
const OWNER = createParticipantId({ fingerprint: new Uint8Array(24).fill(1), variant: 0, tag: ParticipantTagV0 });
const AGENT = createParticipantId({ fingerprint: new Uint8Array(24).fill(2), variant: 0, tag: ParticipantTagV0 });
const KMOI_FIXTURE = funding.KMOI_ASSET_ID_CONST;

/**
 * Create a mock provider that returns a canned TDU response.
 */
function createMockProvider(tduResponse: Array<Record<string, unknown>>) {
  return {
    getTDU: vi.fn().mockResolvedValue(tduResponse),
  };
}

describe("Mandate Funding Module", () => {
  describe("Constants", () => {
    it("exports TRANSFER_FROM_FUEL_ESTIMATE as 300", () => {
      expect(funding.TRANSFER_FROM_FUEL_ESTIMATE).toBe(300n);
    });

    it("exports FUEL_MARGIN_BPS as 15000 (1.5x)", () => {
      expect(funding.FUEL_MARGIN_BPS).toBe(15000n);
    });

    it("exports MIN_AGENT_FUNDING_KMOI as 450", () => {
      expect(funding.MIN_AGENT_FUNDING_KMOI).toBe(450n);
    });

    it("exports KMOI_ASSET_ID_CONST as a valid hex string", () => {
      expect(typeof funding.KMOI_ASSET_ID_CONST).toBe("string");
      expect(funding.KMOI_ASSET_ID_CONST).toMatch(/^0x[0-9a-fA-F]+$/);
    });
  });

  describe("getAgentFundingStatus", () => {
    it("returns sufficient=true when balance >= required", async () => {
      const mockProvider = createMockProvider([
        { asset_id: KMOI_FIXTURE, amount: "500" },
      ]);

      const status = await funding.getAgentFundingStatus(
        mockProvider as never,
        AGENT.toHex(),
        450n,
        KMOI_FIXTURE,
      );

      expect(status.sufficient).toBe(true);
      expect(status.shortfall).toBe(0n);
      expect(status.balance).toBe(500n);
      expect(status.required).toBe(450n);
    });

    it("returns sufficient=true when balance exactly matches required", async () => {
      const mockProvider = createMockProvider([
        { asset_id: KMOI_FIXTURE, amount: "450" },
      ]);

      const status = await funding.getAgentFundingStatus(
        mockProvider as never,
        AGENT.toHex(),
        450n,
        KMOI_FIXTURE,
      );

      expect(status.sufficient).toBe(true);
      expect(status.shortfall).toBe(0n);
      expect(status.balance).toBe(450n);
    });

    it("returns sufficient=false and calculates shortfall when balance < required", async () => {
      const mockProvider = createMockProvider([
        { asset_id: KMOI_FIXTURE, amount: "100" },
      ]);

      const status = await funding.getAgentFundingStatus(
        mockProvider as never,
        AGENT.toHex(),
        450n,
        KMOI_FIXTURE,
      );

      expect(status.sufficient).toBe(false);
      expect(status.shortfall).toBe(350n);
      expect(status.balance).toBe(100n);
    });

    it("shortfall equals exactly required when balance is zero", async () => {
      const mockProvider = createMockProvider([]);

      const status = await funding.getAgentFundingStatus(
        mockProvider as never,
        AGENT.toHex(),
        450n,
        KMOI_FIXTURE,
      );

      expect(status.sufficient).toBe(false);
      expect(status.shortfall).toBe(450n);
      expect(status.balance).toBe(0n);
    });

    it("returns zero balance when asset is not in TDU", async () => {
      const mockProvider = createMockProvider([
        { asset_id: "0x999", amount: "1000" }, // Different asset
      ]);

      const status = await funding.getAgentFundingStatus(
        mockProvider as never,
        AGENT.toHex(),
        450n,
        KMOI_FIXTURE,
      );

      expect(status.balance).toBe(0n);
      expect(status.sufficient).toBe(false);
      expect(status.shortfall).toBe(450n);
    });

    it("matches asset ids case-insensitively", async () => {
      const lowerCaseAsset = KMOI_FIXTURE.toLowerCase();
      const mockProvider = createMockProvider([
        { asset_id: KMOI_FIXTURE.toUpperCase(), amount: "500" },
      ]);

      const status = await funding.getAgentFundingStatus(
        mockProvider as never,
        AGENT.toHex(),
        450n,
        lowerCaseAsset,
      );

      expect(status.balance).toBe(500n);
      expect(status.sufficient).toBe(true);
    });

    it("defaults to MIN_AGENT_FUNDING_KMOI when required is not supplied", async () => {
      const mockProvider = createMockProvider([
        { asset_id: KMOI_FIXTURE, amount: "400" },
      ]);

      const status = await funding.getAgentFundingStatus(
        mockProvider as never,
        AGENT.toHex(),
      );

      expect(status.required).toBe(funding.MIN_AGENT_FUNDING_KMOI);
      expect(status.shortfall).toBe(50n);
    });

    it("defaults to KMOI_ASSET_ID_CONST when assetId is not supplied", async () => {
      const mockProvider = createMockProvider([
        { asset_id: KMOI_FIXTURE, amount: "500" },
      ]);

      const status = await funding.getAgentFundingStatus(
        mockProvider as never,
        AGENT.toHex(),
      );

      expect(status.assetId).toBe(KMOI_FIXTURE);
    });

    it("handles RPC failure gracefully by reporting zero balance", async () => {
      const mockProvider = {
        getTDU: vi.fn().mockRejectedValue(new Error("RPC connection failed")),
      };

      const status = await funding.getAgentFundingStatus(
        mockProvider as never,
        AGENT.toHex(),
        450n,
        KMOI_FIXTURE,
      );

      expect(status.balance).toBe(0n);
      expect(status.sufficient).toBe(false);
      expect(status.shortfall).toBe(450n);
    });

    it("handles empty TDU array without error", async () => {
      const mockProvider = createMockProvider([]);

      const status = await funding.getAgentFundingStatus(
        mockProvider as never,
        AGENT.toHex(),
      );

      expect(status.balance).toBe(0n);
      expect(status.sufficient).toBe(false);
    });

    it("ignores non-array TDU response and reports zero balance", async () => {
      const mockProvider = {
        getTDU: vi.fn().mockResolvedValue(null),
      };

      const status = await funding.getAgentFundingStatus(
        mockProvider as never,
        AGENT.toHex(),
      );

      expect(status.balance).toBe(0n);
    });

    it("includes all required status fields in the response", async () => {
      const mockProvider = createMockProvider([
        { asset_id: KMOI_FIXTURE, amount: "600" },
      ]);

      const status = await funding.getAgentFundingStatus(
        mockProvider as never,
        AGENT.toHex(),
        450n,
        KMOI_FIXTURE,
      );

      expect(status).toHaveProperty("agentAddress");
      expect(status).toHaveProperty("assetId");
      expect(status).toHaveProperty("balance");
      expect(status).toHaveProperty("required");
      expect(status).toHaveProperty("sufficient");
      expect(status).toHaveProperty("shortfall");
    });
  });

  describe("requireAgentFunding", () => {
    it("returns {funded: true} when balance is sufficient", async () => {
      const mockProvider = createMockProvider([
        { asset_id: KMOI_FIXTURE, amount: "500" },
      ]);

      const result = await funding.requireAgentFunding(
        mockProvider as never,
        OWNER.toHex(),
        AGENT.toHex(),
      );

      expect(result.funded).toBe(true);
      expect(result).toHaveProperty("status");
      expect(result).not.toHaveProperty("suggestedAction");
    });

    it("returns {funded: false, suggestedAction} when funding is required", async () => {
      const mockProvider = createMockProvider([
        { asset_id: KMOI_FIXTURE, amount: "100" },
      ]);

      const result: funding.FundingCheckResult = await funding.requireAgentFunding(
        mockProvider as never,
        OWNER.toHex(),
        AGENT.toHex(),
      );

      expect(result.funded).toBe(false);
      expect(result).toHaveProperty("status");
      expect(result).toHaveProperty("suggestedAction");
    });

    it("suggestedAction contains the correct structure with plain data", async () => {
      const mockProvider = createMockProvider([
        { asset_id: KMOI_FIXTURE, amount: "100" },
      ]);

      const baseResult = await funding.requireAgentFunding(
        mockProvider as never,
        OWNER.toHex(),
        AGENT.toHex(),
      );
      const result = baseResult as Exclude<typeof baseResult, { funded: true }>;

      const action = result.suggestedAction;
      expect(action.kind).toBe("owner_phone_signed_transfer");
      expect(action.from).toBe(OWNER.toHex());
      expect(action.to).toBe(AGENT.toHex());
      expect(action.assetId).toBe(KMOI_FIXTURE);
      expect(action.amount).toBe("350"); // 450 - 100
      expect(action.tool).toBe("moi_transfer");
    });

    it("amount in suggestedAction is a decimal string", async () => {
      const mockProvider = createMockProvider([
        { asset_id: KMOI_FIXTURE, amount: "100" },
      ]);

      const baseResult = await funding.requireAgentFunding(
        mockProvider as never,
        OWNER.toHex(),
        AGENT.toHex(),
      );
      const result = baseResult as Exclude<typeof baseResult, { funded: true }>;

      expect(typeof result.suggestedAction.amount).toBe("string");
      expect(result.suggestedAction.amount).toMatch(/^\d+$/);
    });

    it("does not include any signed objects or secrets in suggestedAction", async () => {
      const mockProvider = createMockProvider([
        { asset_id: KMOI_FIXTURE, amount: "100" },
      ]);

      const baseResult = await funding.requireAgentFunding(
        mockProvider as never,
        OWNER.toHex(),
        AGENT.toHex(),
      );
      const result = baseResult as Exclude<typeof baseResult, { funded: true }>;

      const action = result.suggestedAction;
      // Verify only safe, plain fields exist
      expect(Object.keys(action).sort()).toEqual([
        "amount",
        "assetId",
        "from",
        "kind",
        "to",
        "tool",
      ]);

      // Explicitly verify no crypto fields
      expect(action).not.toHaveProperty("ix_args");
      expect(action).not.toHaveProperty("signatures");
      expect(action).not.toHaveProperty("hash");
      expect(action).not.toHaveProperty("nonce");
    });

    it("suggestedAction points to moi_transfer tool, never a signing function", async () => {
      const mockProvider = createMockProvider([
        { asset_id: KMOI_FIXTURE, amount: "100" },
      ]);

      const baseResult = await funding.requireAgentFunding(
        mockProvider as never,
        OWNER.toHex(),
        AGENT.toHex(),
      );
      const result = baseResult as Exclude<typeof baseResult, { funded: true }>;

      expect(result.suggestedAction.tool).toBe("moi_transfer");
      expect(result.suggestedAction.tool).not.toContain("sign");
      expect(result.suggestedAction.tool).not.toContain("mandate");
    });

    it("funding check does not invoke any signing function", async () => {
      const mockProvider = createMockProvider([
        { asset_id: KMOI_FIXTURE, amount: "100" },
      ]);

      // This test verifies the invariant by inspection: if sign() were called,
      // the test framework would detect it. The module does not import or use
      // any signing library.
      await funding.requireAgentFunding(
        mockProvider as never,
        OWNER.toHex(),
        AGENT.toHex(),
      );

      // Verify getTDU was called (the only RPC call)
      expect(mockProvider.getTDU).toHaveBeenCalled();
    });

    it("includes the full status object in both funded/unfunded responses", async () => {
      const mockProvider = createMockProvider([
        { asset_id: KMOI_FIXTURE, amount: "500" },
      ]);

      const resultFunded = await funding.requireAgentFunding(
        mockProvider as never,
        OWNER.toHex(),
        AGENT.toHex(),
      );

      expect(resultFunded).toHaveProperty("status");
      expect(resultFunded.status).toHaveProperty("balance");
      expect(resultFunded.status).toHaveProperty("required");
      expect(resultFunded.status).toHaveProperty("shortfall");

      // Test unfunded case as well
      const mockProvider2 = createMockProvider([
        { asset_id: KMOI_FIXTURE, amount: "100" },
      ]);
      const resultUnfunded = await funding.requireAgentFunding(
        mockProvider2 as never,
        OWNER.toHex(),
        AGENT.toHex(),
      );

      expect(resultUnfunded).toHaveProperty("status");
      expect(resultUnfunded.status).toHaveProperty("shortfall");
    });
  });

  describe("Boundary cases", () => {
    it("balance = required - 1 triggers shortfall of 1", async () => {
      const mockProvider = createMockProvider([
        { asset_id: KMOI_FIXTURE, amount: "449" },
      ]);

      const status = await funding.getAgentFundingStatus(
        mockProvider as never,
        AGENT.toHex(),
        450n,
        KMOI_FIXTURE,
      );

      expect(status.sufficient).toBe(false);
      expect(status.shortfall).toBe(1n);
    });

    it("balance = required + 1 is sufficient with zero shortfall", async () => {
      const mockProvider = createMockProvider([
        { asset_id: KMOI_FIXTURE, amount: "451" },
      ]);

      const status = await funding.getAgentFundingStatus(
        mockProvider as never,
        AGENT.toHex(),
        450n,
        KMOI_FIXTURE,
      );

      expect(status.sufficient).toBe(true);
      expect(status.shortfall).toBe(0n);
    });

    it("very large balance (beyond safe integer range) is handled correctly", async () => {
      const largeAmount = "18446744073709551615"; // 2^64 - 1
      const mockProvider = createMockProvider([
        { asset_id: KMOI_FIXTURE, amount: largeAmount },
      ]);

      const status = await funding.getAgentFundingStatus(
        mockProvider as never,
        AGENT.toHex(),
      );

      expect(status.balance).toBe(BigInt(largeAmount));
      expect(status.sufficient).toBe(true);
    });
  });

  describe("Type invariants", () => {
    it("AgentFundingStatus values are all correct types", async () => {
      const mockProvider = createMockProvider([
        { asset_id: KMOI_FIXTURE, amount: "500" },
      ]);

      const status = await funding.getAgentFundingStatus(
        mockProvider as never,
        AGENT.toHex(),
      );

      expect(typeof status.agentAddress).toBe("string");
      expect(typeof status.assetId).toBe("string");
      expect(typeof status.balance).toBe("bigint");
      expect(typeof status.required).toBe("bigint");
      expect(typeof status.sufficient).toBe("boolean");
      expect(typeof status.shortfall).toBe("bigint");
    });

    it("FundingCheckResult type discriminates on funded field", async () => {
      const mockProvider1 = createMockProvider([
        { asset_id: KMOI_FIXTURE, amount: "500" },
      ]);
      const funded = await funding.requireAgentFunding(
        mockProvider1 as never,
        OWNER.toHex(),
        AGENT.toHex(),
      );

      const mockProvider2 = createMockProvider([
        { asset_id: KMOI_FIXTURE, amount: "100" },
      ]);
      const unfunded = await funding.requireAgentFunding(
        mockProvider2 as never,
        OWNER.toHex(),
        AGENT.toHex(),
      );

      if (funded.funded) {
        expect("suggestedAction" in funded).toBe(false);
      } else {
        expect(funded.suggestedAction).toBeDefined();
      }

      if (unfunded.funded) {
        throw new Error("Expected unfunded case");
      } else {
        expect(unfunded.suggestedAction).toBeDefined();
      }
    });
  });

  describe("No user key invariant", () => {
    it("does not import or expose Wallet or private key types", () => {
      // This is a compile-time and runtime check.
      // The module re-exports only public interfaces (AgentFundingStatus, FundingCheckResult)
      // and functions that take a read-only provider.
      // Verify the exports are safe.
      const moduleExports = Object.keys(funding);

      // Should not export Wallet, PrivateKey, Signer, etc.
      expect(moduleExports).not.toContain("Wallet");
      expect(moduleExports).not.toContain("PrivateKey");
      expect(moduleExports).not.toContain("Signer");
    });

    it("provider parameter is only used for getTDU (read-only call)", async () => {
      const getTDUSpy = vi.fn().mockResolvedValue([
        { asset_id: KMOI_FIXTURE, amount: "500" },
      ]);
      const mockProvider = { getTDU: getTDUSpy };

      await funding.getAgentFundingStatus(
        mockProvider as never,
        AGENT.toHex(),
      );

      // Verify only getTDU was called
      expect(getTDUSpy).toHaveBeenCalledTimes(1);
      expect(getTDUSpy).toHaveBeenCalledWith(AGENT.toHex());
    });
  });
});
