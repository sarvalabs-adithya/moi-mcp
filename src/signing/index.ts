/**
 * Abstraction over signing providers. Plugs different signers (phone-based,
 * agent-key-based) into the write path without duplicating sign→broadcast logic.
 *
 * No MCP imports; safe for use in multiple contexts.
 */

import { MoiError } from "../moi-error.js";
import { ErrorCode } from "../schema.js";
import type { UnsignedInteraction } from "../moi/ix-builder.js";
import type { Session } from "../wc/session.js";
import type { WalletConnectClient } from "../wc/client.js";

/**
 * What a write path needs from a signer, regardless of where signing happens.
 * The sign() method must return ix_args and signatures in the format expected
 * by a MOI provider's sendInteraction() call.
 */
export interface InteractionSigner {
  /** Diagnostic label (e.g., "phone:0xabc..." or "agent:0xdef..."). Never a secret. */
  readonly label: string;

  /**
   * Sign the interaction and return the signed payload.
   * Implementations are responsible for error handling and translation.
   */
  sign(
    ix: UnsignedInteraction,
    opts?: { description?: string },
  ): Promise<{ ix_args: string; signatures: string }>;
}

/**
 * Wraps the existing WalletConnect phone-sign path unchanged.
 * This is the ONLY InteractionSigner allowed to touch the owner's real wallet.
 */
export class PhoneSigner implements InteractionSigner {
  readonly label: string;

  constructor(
    private readonly client: WalletConnectClient,
    private readonly session: Session,
  ) {
    this.label = `phone:${session.account.slice(0, 8)}…`;
  }

  async sign(
    ix: UnsignedInteraction,
    opts?: { description?: string },
  ): Promise<{ ix_args: string; signatures: string }> {
    return this.client.signInteraction(this.session, ix, opts);
  }
}

/**
 * Sign and broadcast in one call. Same split as today's signAndBroadcast,
 * generalized over InteractionSigner. This implementation is kept as two steps
 * because the wallet's combined moi.sendInteractions is broken — this is not
 * new risk, it is the existing constraint made provider-agnostic.
 *
 * The "approved but broadcast failed" error copy is preserved verbatim from
 * the original writes.ts implementation, as it is user-facing text.
 */
export async function signAndBroadcast(
  signer: InteractionSigner,
  provider: {
    sendInteraction(req: { ix_args: string; signatures: string }): Promise<{ hash: string }>;
  },
  ix: UnsignedInteraction,
  description: string,
): Promise<string> {
  void description; // Used for logging/diagnostics at the signer level; not consumed here

  const signed = await signer.sign(ix, { description });

  try {
    const response = await provider.sendInteraction(signed);
    const hash = response?.hash;
    if (typeof hash !== "string" || !/^0x[0-9a-fA-F]+$/.test(hash)) {
      throw new MoiError(ErrorCode.RPC_ERROR, `Node accepted the interaction but returned no hash.`);
    }
    return hash;
  } catch (err) {
    if (err instanceof MoiError) throw err;
    throw new MoiError(
      ErrorCode.RPC_ERROR,
      `You approved the interaction but broadcasting it failed: ${err instanceof Error ? err.message.slice(0, 180) : String(err)}`,
    );
  }
}
