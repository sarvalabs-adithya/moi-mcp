#!/usr/bin/env -S npx tsx
/**
 * Mandate loop spike — proves (or shows exactly why it can't yet prove) the
 * Approve -> TransferFrom -> Revoke loop against MOI's voyage devnet, without
 * touching the user's wallet, phone, or keys.
 *
 * Two throwaway wallets are generated fresh every run:
 *   O (owner)  - grants a mandate
 *   A (agent)  - spends under that mandate
 * Both are pure `js-moi-sdk` `Wallet` instances created with
 * `Wallet.createRandom()`. Their private keys/mnemonics are written ONLY to
 * MANDATE_SPIKE_SCRATCH_DIR (never this repo) so a rerun can reuse the same
 * pair instead of generating (and needing to re-fund) new ones every time.
 *
 * Flow:
 *   1. Load or generate O and A.
 *   2. Probe the voyage faucet's HTTP surface (GET the page, then POST the
 *      claim endpoint it actually calls) to determine whether funding O is
 *      scriptable at all. Never attempts to defeat whatever gate is found.
 *   3. Read O and A's on-chain account state (free — no funds needed).
 *   4. If funding succeeded: run the full signed loop — Approve, an
 *      in-cap TransferFrom, an over-cap TransferFrom (expected refusal),
 *      Revoke, then a post-revoke TransferFrom (expected refusal) — signing
 *      locally with each wallet and broadcasting for real, printing every
 *      interaction hash.
 *   5. If funding is blocked: build the same five interactions and run them
 *      through the node's `moi.Call` simulate RPC (this needs no funds and
 *      broadcasts nothing) to see exactly how deep simulation gets, and
 *      report precisely which step first needs money.
 *
 * This script never imports `../src/server.ts`, the MCP tool layer, or
 * anything WalletConnect-shaped — it drives `src/moi/*` directly, the same
 * way any MOI dapp would.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { KMOI_ASSET_ID, Wallet, type SigType } from "js-moi-sdk";

import { getProvider, NETWORKS } from "../src/moi/provider.js";
import { getAccount } from "../src/moi/reads.js";
import {
  assertSendable,
  estimateFuelFor,
  simulate,
  type SenderInfo,
  type UnsignedInteraction,
} from "../src/moi/ix-builder.js";
import { buildApprove, buildRevoke, buildTransferFrom } from "../src/moi/mandates.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const SCRATCH_DIR =
  process.env.MANDATE_SPIKE_SCRATCH_DIR ??
  "/private/tmp/claude-501/-Users-adithyaganesh-personal-website--claude-worktrees-moi-mcp-chats-fd2347/05b415fe-9fb9-44cd-b8fc-5a614bfde1d8/scratchpad";
const KEY_FILE = path.join(SCRATCH_DIR, "mandate-spike-keys.json");

const NETWORK = "voyage" as const;
const ASSET_ID = KMOI_ASSET_ID; // No mandate-specific test asset exists; KMOI is a MAS0 asset like any other.
const CAP = 1_000n; // Approve() ceiling, base units.
const WITHIN_CAP_SPEND = 400n; // Second TransferFrom amount, must be <= CAP.
const OVER_CAP_SPEND = 5_000n; // Third TransferFrom amount, must be > CAP.
const EXPIRES_AT = Math.floor(Date.now() / 1000) + 3600; // 1h from now.

const SIG_TYPE = { prefix: 0, sigName: "ecdsa_secp256k1" } as unknown as SigType;

function hr(title: string): void {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`);
}

interface KeyRecord {
  mnemonic: string;
}
interface KeyFile {
  owner: KeyRecord;
  agent: KeyRecord;
}

async function loadOrCreateWallets(): Promise<{ owner: Wallet; agent: Wallet; reused: boolean }> {
  mkdirSync(SCRATCH_DIR, { recursive: true });

  if (existsSync(KEY_FILE)) {
    const raw = JSON.parse(readFileSync(KEY_FILE, "utf8")) as KeyFile;
    const owner = await Wallet.fromMnemonic(raw.owner.mnemonic);
    const agent = await Wallet.fromMnemonic(raw.agent.mnemonic);
    return { owner, agent, reused: true };
  }

  const owner = await Wallet.createRandom();
  const agent = await Wallet.createRandom();
  const record: KeyFile = {
    owner: { mnemonic: owner.mnemonic },
    agent: { mnemonic: agent.mnemonic },
  };
  writeFileSync(KEY_FILE, JSON.stringify(record, null, 2), { mode: 0o600 });
  return { owner, agent, reused: false };
}

// ---------------------------------------------------------------------------
// Faucet probe — inspect only, never attempt to defeat a gate we find.
// ---------------------------------------------------------------------------

interface FaucetProbeResult {
  scriptable: boolean;
  detail: string;
}

async function probeFaucet(): Promise<FaucetProbeResult> {
  // 1. The faucet page itself: confirm it's a client-rendered app, not a form
  //    a plain POST could drive.
  const pageRes = await fetch("https://voyage.moi.technology/faucet/", {
    headers: { "user-agent": "Mozilla/5.0" },
  });
  const pageBody = await pageRes.text();
  const isNextApp = pageBody.includes("__NEXT_DATA__") || pageBody.includes("_next/static");
  console.log(`  GET /faucet/ -> ${pageRes.status}, Next.js SPA: ${isNextApp}`);

  // 2. The actual claim endpoint the page's bundled JS calls
  //    (`https://api-voyage.moi.technology/api/` + `faucet/claim/token/<id>`,
  //    found by walking the page's own webpack module cache for the string
  //    constant it POSTs against — see HANDOFF notes). Hit it with an
  //    obviously-fake body to see what it demands, nothing more.
  const claimRes = await fetch("https://api-voyage.moi.technology/api/faucet/claim/token/1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ moi_id: "probe", account_id: "0x00", public_key: "0x00" }),
  });
  const claimBody = await claimRes.text();
  console.log(`  POST /api/faucet/claim/token/1 -> ${claimRes.status}: ${claimBody.slice(0, 200)}`);

  if (claimRes.status === 401 || /authentication|invalid token/i.test(claimBody)) {
    return {
      scriptable: false,
      detail:
        `Faucet claim endpoint requires an Authorization bearer token minted by MOI's own ` +
        `wallet-authentication login flow (a signed-challenge login through the MOI Wallet browser ` +
        `extension / voyage web app — see https://voyage-docs.moi.technology/docs/wallet-authentication/), ` +
        `not just a devnet keypair. That flow is browser+extension-only and gated behind a real account ` +
        `signup ("moi_id"), so it is out of reach of a plain HTTP client and out of scope to defeat.`,
    };
  }
  return { scriptable: true, detail: `Claim endpoint responded ${claimRes.status} without auth.` };
}

// ---------------------------------------------------------------------------
// Sender / sequence resolution
// ---------------------------------------------------------------------------

async function resolveSender(
  provider: ReturnType<typeof getProvider>,
  wallet: Wallet,
): Promise<{ sender: SenderInfo; sequenceSource: "chain" | "fallback-0"; note?: string }> {
  const id = (await wallet.getIdentifier()).toHex();
  try {
    const seq = Number(
      await (provider as unknown as { getPendingInteractionCount: (id: string, keyId: number) => Promise<number | bigint> }).getPendingInteractionCount(
        id,
        0,
      ),
    );
    return { sender: { id, sequence: seq, keyId: 0 }, sequenceSource: "chain" };
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err);
    return { sender: { id, sequence: 0, keyId: 0 }, sequenceSource: "fallback-0", note };
  }
}

// ---------------------------------------------------------------------------
// One step: build, simulate, and (if funded) sign + broadcast.
// ---------------------------------------------------------------------------

interface StepOutcome {
  label: string;
  built: boolean;
  simulate?: { ok: boolean; status?: number; fuelUsed?: number; detail?: string };
  broadcast?: { hash: string } | { error: string };
}

async function runStep(
  label: string,
  provider: ReturnType<typeof getProvider>,
  buildIx: () => Promise<UnsignedInteraction>,
  signer: Wallet,
  live: boolean,
): Promise<StepOutcome> {
  console.log(`\n-- ${label} --`);
  let ix: UnsignedInteraction;
  try {
    ix = await buildIx();
    assertSendable(ix);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log(`  build FAILED: ${detail}`);
    return { label, built: false };
  }
  console.log(`  built: sender=${ix.sender.id} sequence=${ix.sender.sequence}`);

  const simResult = await simulate(
    provider as unknown as { call: (i: unknown) => Promise<unknown> },
    ix,
  );
  console.log(`  simulate: ok=${simResult.ok} status=${simResult.status ?? "?"} detail=${simResult.detail ?? "-"}`);

  const outcome: StepOutcome = { label, built: true, simulate: simResult };

  if (!live) {
    console.log(`  broadcast: SKIPPED (funding blocked — see above)`);
    return outcome;
  }

  if (!simResult.ok) {
    console.log(`  broadcast: SKIPPED (simulation predicts failure — matches writes.ts's assertWillSucceed policy)`);
    return outcome;
  }

  try {
    const { fuelLimit } = await estimateFuelFor(
      provider as unknown as { estimateFuel: (i: unknown) => Promise<number | bigint> },
      ix,
    );
    const signed = await signer.signInteraction({ ...ix, fuel_limit: fuelLimit } as unknown as never, SIG_TYPE);
    const response = await (
      provider as unknown as {
        sendInteraction: (r: { ix_args: string; signatures: string }) => Promise<{ hash: string }>;
      }
    ).sendInteraction({ ix_args: String(signed.ix_args), signatures: String(signed.signatures) });
    console.log(`  broadcast: hash=${response.hash}`);
    outcome.broadcast = { hash: response.hash };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.log(`  broadcast FAILED: ${error}`);
    outcome.broadcast = { error };
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  hr("1. Wallets");
  const { owner, agent, reused } = await loadOrCreateWallets();
  const ownerId = (await owner.getIdentifier()).toHex();
  const agentId = (await agent.getIdentifier()).toHex();
  console.log(`Owner (O): ${ownerId} ${reused ? "(reused from scratch dir)" : "(freshly generated)"}`);
  console.log(`Agent (A): ${agentId} ${reused ? "(reused from scratch dir)" : "(freshly generated)"}`);
  console.log(`Keys stored at: ${KEY_FILE} (never in the repo)`);
  console.log(`Network: ${NETWORK} (${NETWORKS[NETWORK].rpcUrl})`);

  hr("2. Faucet probe");
  const faucet = await probeFaucet();
  console.log(`\nFunding O via faucet: ${faucet.scriptable ? "SCRIPTABLE" : "BLOCKED"}`);
  console.log(faucet.detail);

  const provider = getProvider({ network: NETWORK });

  hr("3. Initial account state (read-only, needs no funds)");
  for (const [label, id] of [["O", ownerId], ["A", agentId]] as const) {
    try {
      const state = await getAccount(provider, id);
      console.log(
        `${label} (${id}): isRegistered=${state.isRegistered} nonce=${state.nonce} balances=${JSON.stringify(state.balances)}`,
      );
    } catch (err) {
      console.log(`${label} (${id}): getAccount FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const live = faucet.scriptable; // Would flip true only after a real funding step we never reach.
  if (!live) {
    console.log(
      "\nSince funding is blocked, everything below runs in DRY mode: each interaction is built and " +
        "sent through the node's read-only moi.Call simulate RPC (no signature, no broadcast, no funds " +
        "needed for the RPC call itself) so we can see exactly how far the node gets before it needs money.",
    );
  }

  hr("4. Approve — O grants A a cap of " + CAP + " KMOI-units until " + EXPIRES_AT);
  const ownerSender = await resolveSender(provider, owner);
  if (ownerSender.sequenceSource === "fallback-0") {
    console.log(`  (O has no on-chain sequence yet — PendingInteractionCount: ${ownerSender.note}; using 0)`);
  }
  const approveOutcome = await runStep(
    "Approve(O -> A)",
    provider,
    () =>
      buildApprove(owner, ownerSender.sender, {
        assetId: ASSET_ID,
        beneficiary: agentId,
        amount: CAP,
        expiresAt: EXPIRES_AT,
      }),
    owner,
    live,
  );

  hr("5. TransferFrom — A spends " + WITHIN_CAP_SPEND + " (within cap)");
  const agentSender1 = await resolveSender(provider, agent);
  if (agentSender1.sequenceSource === "fallback-0") {
    console.log(`  (A has no on-chain sequence yet — PendingInteractionCount: ${agentSender1.note}; using 0)`);
  }
  const withinCapOutcome = await runStep(
    "TransferFrom(A spends within cap)",
    provider,
    () =>
      buildTransferFrom(agent, agentSender1.sender, {
        assetId: ASSET_ID,
        benefactor: ownerId,
        beneficiary: agentId,
        amount: WITHIN_CAP_SPEND,
      }),
    agent,
    live,
  );

  hr("6. TransferFrom — A attempts " + OVER_CAP_SPEND + " (over cap, expect refusal)");
  const agentSender2 = await resolveSender(provider, agent);
  const overCapOutcome = await runStep(
    "TransferFrom(A attempts over cap)",
    provider,
    () =>
      buildTransferFrom(agent, agentSender2.sender, {
        assetId: ASSET_ID,
        benefactor: ownerId,
        beneficiary: agentId,
        amount: OVER_CAP_SPEND,
      }),
    agent,
    live,
  );

  hr("7. Revoke — O revokes A's mandate");
  const ownerSender2 = await resolveSender(provider, owner);
  const revokeOutcome = await runStep(
    "Revoke(O revokes A)",
    provider,
    () => buildRevoke(owner, ownerSender2.sender, { assetId: ASSET_ID, beneficiary: agentId }),
    owner,
    live,
  );

  hr("8. TransferFrom — A attempts " + WITHIN_CAP_SPEND + " again (post-revoke, expect refusal)");
  const agentSender3 = await resolveSender(provider, agent);
  const postRevokeOutcome = await runStep(
    "TransferFrom(A attempts post-revoke)",
    provider,
    () =>
      buildTransferFrom(agent, agentSender3.sender, {
        assetId: ASSET_ID,
        benefactor: ownerId,
        beneficiary: agentId,
        amount: WITHIN_CAP_SPEND,
      }),
    agent,
    live,
  );

  hr("Summary");
  console.log(`Network:            ${NETWORK} (${NETWORKS[NETWORK].rpcUrl})`);
  console.log(`Owner O:            ${ownerId}`);
  console.log(`Agent A:            ${agentId}`);
  console.log(`Faucet funding:     ${live ? "LIVE (funded)" : "BLOCKED"} — ${faucet.detail}`);
  console.log(`Mode:               ${live ? "LIVE (signed + broadcast)" : "DRY (build + simulate only)"}`);
  for (const outcome of [approveOutcome, withinCapOutcome, overCapOutcome, revokeOutcome, postRevokeOutcome]) {
    const bcast = outcome.broadcast
      ? "hash" in outcome.broadcast
        ? `broadcast hash=${outcome.broadcast.hash}`
        : `broadcast error=${outcome.broadcast.error}`
      : "not broadcast";
    console.log(
      `  - ${outcome.label}: built=${outcome.built} simulate.ok=${outcome.simulate?.ok ?? "n/a"} (${bcast})`,
    );
  }
  console.log(
    "\nNote: because nothing above was ever broadcast, each simulate() call is independent and evaluated " +
      "against the SAME unchanged chain state (no Approve ever actually landed) — a within-cap and an " +
      "over-cap TransferFrom failing for the same reason (no on-chain allowance / no balance) is not by " +
      "itself proof that cap enforcement works, only that the build+simulate plumbing round-trips real " +
      "devnet responses end to end. Proving the cap-enforcement distinction needs the funded, fully-signed " +
      "loop above.",
  );
}

main().catch((err) => {
  console.error("\nFATAL:", err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
