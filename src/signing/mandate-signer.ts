/**
 * InteractionSigner backed by the server-held agent key.
 *
 * The ONLY signer allowed to sign TransferFrom for delegated spend operations.
 * Knows nothing about caps or mandate state — those are enforced one layer up
 * in the ledger before this signer is ever invoked.
 */

import { scryptSync } from "node:crypto";
import { Wallet } from "js-moi-wallet";
import type { SigType } from "js-moi-signer";

import { asRpcError, MoiError } from "../moi-error.js";
import { ErrorCode } from "../schema.js";
import type { UnsignedInteraction } from "../moi/ix-builder.js";
import { InteractionSigner } from "./index.js";
import { FileAgentKeyStore, loadAgentWallet, type AgentKeyStore } from "./agent-keys.js";

/**
 * InteractionSigner backed by the server-held agent key.
 * Signs TransferFrom interactions for delegated spend operations.
 */
export class MandateSigner implements InteractionSigner {
  readonly label: string;

  constructor(private readonly wallet: Wallet) {
    // Derive a short label for diagnostics (the agent's participant id).
    // We cannot access wallet.address directly as it's an async property,
    // so use a placeholder; the actual address is available in moi_mandate_status output.
    this.label = `agent:mandate`;
  }

  /**
   * Sign a TransferFrom interaction using the agent's wallet.
   * Returns the exact shape expected by provider.sendInteraction():
   * { ix_args: hex string, signatures: hex string }
   */
  async sign(
    ix: UnsignedInteraction,
    opts?: { description?: string },
  ): Promise<{ ix_args: string; signatures: string }> {
    void opts; // description is passed for logging at the call site; not used here

    try {
      // Sign the interaction using the agent wallet.
      // Wallet.signInteraction(ixObject, sigAlgo) returns InteractionRequest:
      // { ix_args: hex, signatures: hex }
      // The sigAlgo parameter is ignored internally by the SDK (hardcoded to ECDSA secp256k1),
      // but we pass a SigType for clarity and forward compatibility.
      // Cast ix to unknown to match the SDK's InteractionObject type.
      const sigType = {
        prefix: 0,
        sigName: "ecdsa_secp256k1",
      } as unknown as SigType;
      const signed = await this.wallet.signInteraction(ix as unknown as never, sigType);

      // The SDK returns InteractionRequest with ix_args and signatures as hex strings.
      // Cast to our expected shape.
      return {
        ix_args: String(signed.ix_args),
        signatures: String(signed.signatures),
      };
    } catch (err) {
      throw asRpcError(err, "Failed to sign interaction with agent key");
    }
  }
}

/**
 * Construct a MandateSigner for a user's agent key.
 * Loads the wallet from the store using the derived keystore password.
 */
export async function mandateSignerFor(
  store: AgentKeyStore,
  userId: string,
  keystorePassword: string,
): Promise<MandateSigner> {
  try {
    const wallet = await loadAgentWallet(store, userId, keystorePassword);
    return new MandateSigner(wallet);
  } catch (err) {
    // loadAgentWallet already throws MoiError; re-throw as-is
    throw err;
  }
}

/**
 * Convenience factory using FileAgentKeyStore.
 */
export async function mandateSignerForUser(
  dataDir: string,
  userId: string,
): Promise<MandateSigner> {
  const store = new FileAgentKeyStore(dataDir);
  const keystorePassword = deriveKeystorePassword(userId);
  return mandateSignerFor(store, userId, keystorePassword);
}

/**
 * Derive the keystore password (same logic as in FileAgentKeyStore).
 * Factored out here for unit tests that don't want to instantiate the store.
 */
function deriveKeystorePassword(userId: string): string {
  const secret = process.env.MOI_AGENT_KEYSTORE_SECRET;
  if (!secret) {
    throw new MoiError(
      ErrorCode.CONFIGURATION_ERROR,
      "MOI_AGENT_KEYSTORE_SECRET is not set. Agent key provisioning requires this env var.",
    );
  }

  try {
    const derived = scryptSync(secret, userId, 32, {
      N: 16384,
      r: 8,
      p: 1,
    });
    return derived.toString("hex");
  } catch (err) {
    // Don't wrap MoiErrors
    if (err instanceof MoiError) throw err;
    throw asRpcError(err, "Failed to derive keystore password");
  }
}
