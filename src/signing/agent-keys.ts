/**
 * Per-user agent key storage. Each agent is a throwaway keypair generated once
 * and stored encrypted on the server.
 *
 * This is the v2 custody trade: the user's key stays on their phone, but the
 * server holds a per-user agent key for delegated spend operations. The agent
 * key is stored encrypted in the same way as wallet sessions — never plaintext
 * on disk, never logged.
 */

import { createHash, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Wallet } from "js-moi-wallet";
import { z } from "zod";

import { log } from "../config.js";
import { asRpcError, MoiError } from "../moi-error.js";
import { ErrorCode } from "../schema.js";

/**
 * Agent key record: the encrypted keystore and metadata.
 * Matches AgentKeyRecord from the contract.
 */
export const AgentKeyRecord = z.object({
  version: z.literal(1),
  userId: z.string(),
  address: z.string(), // participant id (public, safe to return in output)
  keystore: z.string(), // Wallet.generateKeystore JSON — ciphertext, not plaintext
  createdAt: z.string(), // ISO datetime
});
export type AgentKeyRecord = z.infer<typeof AgentKeyRecord>;

/**
 * Interface for agent key storage.
 */
export interface AgentKeyStore {
  /**
   * Retrieve the agent key for a user, or undefined if never created.
   */
  get(userId: string): Promise<AgentKeyRecord | undefined>;

  /**
   * Get the existing agent key, or create one on first call.
   * Idempotent: same userId always returns the same address.
   */
  getOrCreate(userId: string): Promise<AgentKeyRecord>;

  /**
   * Delete a user's agent key record.
   */
  delete(userId: string): Promise<void>;
}

/**
 * File-backed agent key store.
 * Stores records at <dataDir>/agents/{sha256(userId)}.json with 0600 permissions.
 * Mirrors FileWalletSessionStore's atomic-write and error-handling pattern exactly.
 */
export class FileAgentKeyStore implements AgentKeyStore {
  /** Tail promise per userId, serializing first-time key creation. */
  private readonly createQueues = new Map<string, Promise<unknown>>();

  private agentsDir: string;

  constructor(dataDir: string) {
    this.agentsDir = join(dataDir, "agents");
    mkdirSync(this.agentsDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Get an agent key record by user ID, returning undefined if missing or unparsable.
   */
  async get(userId: string): Promise<AgentKeyRecord | undefined> {
    const file = this.userAgentPath(userId);
    if (!existsSync(file)) return undefined;

    try {
      const data = readFileSync(file, "utf8");
      const parsed = AgentKeyRecord.safeParse(JSON.parse(data));
      if (!parsed.success) {
        log("error", `Failed to parse agent key record for user ${userId}: ${parsed.error.message}`);
        return undefined;
      }
      return parsed.data;
    } catch (err) {
      log("error", `Failed to read agent key record for user ${userId}: ${String(err)}`);
      return undefined;
    }
  }

  /**
   * Get or create an agent key record.
   * On first call, generates a new Wallet, stores it encrypted, and returns the record.
   * Subsequent calls return the existing record (idempotent).
   */
  async getOrCreate(userId: string): Promise<AgentKeyRecord> {
    // Serialize per user: without this, two concurrent first-time calls both
    // see no record, each generate a different wallet, and the later set()
    // wins — leaving the other caller holding an address nothing can sign for.
    const tail = this.createQueues.get(userId) ?? Promise.resolve();
    const run = tail.then(
      () => this.getOrCreateUnlocked(userId),
      () => this.getOrCreateUnlocked(userId),
    );
    this.createQueues.set(
      userId,
      run.catch(() => undefined),
    );
    return run;
  }

  private async getOrCreateUnlocked(userId: string): Promise<AgentKeyRecord> {
    // Check if already exists
    const existing = await this.get(userId);
    if (existing) return existing;

    // Create new agent wallet
    let wallet: Wallet;
    try {
      wallet = await Wallet.createRandom();
    } catch (err) {
      throw asRpcError(err, "Failed to generate agent wallet");
    }

    // Get the agent's participant ID (address)
    let address: string;
    try {
      const identifier = await wallet.identifier;
      address = identifier.toString();
    } catch (err) {
      throw asRpcError(err, "Failed to derive agent address from wallet");
    }

    // Encrypt the keystore using a derived password (KDF from env secret + userId)
    let keystore: string;
    try {
      const password = this.deriveKeystorePassword(userId);
      const keystoreObj = wallet.generateKeystore(password);
      keystore = JSON.stringify(keystoreObj);
    } catch (err) {
      // Don't wrap MoiErrors (e.g., CONFIGURATION_ERROR from missing env var)
      if (err instanceof MoiError) throw err;
      throw asRpcError(err, "Failed to encrypt agent keystore");
    }

    // Build the record
    const record: AgentKeyRecord = {
      version: 1,
      userId,
      address,
      keystore,
      createdAt: new Date().toISOString(),
    };

    // Persist atomically
    await this.set(record);

    return record;
  }

  /**
   * Delete a user's agent key record.
   */
  async delete(userId: string): Promise<void> {
    const file = this.userAgentPath(userId);
    rmSync(file, { force: true });
  }

  /**
   * Persist an agent key record atomically (write to temp, then rename).
   */
  private async set(record: AgentKeyRecord): Promise<void> {
    const file = this.userAgentPath(record.userId);
    const tmpFile = `${file}.tmp`;

    mkdirSync(this.agentsDir, { recursive: true, mode: 0o700 });

    // Write to temp file with 0600 permissions, then atomically rename
    writeFileSync(tmpFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    const fs = await import("node:fs/promises");
    await fs.rename(tmpFile, file);
  }

  /**
   * Get the file path for a user's agent key, using sha256(userId) as filename.
   */
  private userAgentPath(userId: string): string {
    const hash = createHash("sha256").update(userId).digest("hex");
    return join(this.agentsDir, `${hash}.json`);
  }

  /**
   * Derive a keystore password from the server secret and userId.
   * Uses scrypt as a KDF: a compromise the user's key is compromised only if
   * both the on-disk keystore file AND the server secret leak.
   *
   * Throws if MOI_AGENT_KEYSTORE_SECRET is not set (fail-closed).
   */
  private deriveKeystorePassword(userId: string): string {
    const secret = process.env.MOI_AGENT_KEYSTORE_SECRET;
    if (!secret) {
      throw new MoiError(
        ErrorCode.CONFIGURATION_ERROR,
        "MOI_AGENT_KEYSTORE_SECRET is not set. Agent key provisioning requires this env var.",
      );
    }

    // Derive a password using scrypt. Parameters:
    // - N=16384 (2^14): reasonable cost for a password derivation, not parallelizable
    // - r=8, p=1: default fine for single-thread use
    // - keylen=32: 256-bit derived key
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
}

/**
 * Load an agent Wallet in memory for the duration of one call stack only.
 * Never cached across requests, never logged, never written back plaintext.
 *
 * Throws if the record is missing, the password is wrong, or decryption fails.
 */
export async function loadAgentWallet(
  store: AgentKeyStore,
  userId: string,
  keystorePassword: string,
): Promise<Wallet> {
  const record = await store.get(userId);
  if (!record) {
    throw new MoiError(
      ErrorCode.MANDATE_NOT_FOUND,
      "No agent key found for this user. Call moi_grant_mandate to provision one.",
    );
  }

  try {
    const keystoreObj = JSON.parse(record.keystore);
    const wallet = Wallet.fromKeystore(keystoreObj, keystorePassword);
    return wallet;
  } catch (err) {
    throw new MoiError(
      ErrorCode.UNAUTHORIZED,
      "Failed to decrypt agent keystore. The password may be incorrect or the keystore corrupted.",
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }
}
