# Testing plan

Two implementations, three tiers. The tiers exist because the interesting
failures in this project were not catchable at the tier below.

| Tier | Runs where | Needs | Command |
|---|---|---|---|
| Unit | CI, every push | nothing | `npm test` |
| Live read | on demand | network | `npm run test:e2e` |
| Wallet | manual | a phone | see below |

---

## Tier 1 — unit (120 tests, hermetic)

```bash
npm test          # TypeScript
go test ./...     # Go
```

No network, no wallet. Everything here must stay deterministic so CI never
flakes on someone else's uptime.

**What it covers, and why each exists.** Every group below was written after a
real failure, not speculatively:

- **Amount scaling** — bigint/`big.Int` throughout, asserted past 2^53. A
  float64 loses precision silently on MOI supplies.
- **POLO encoding of all three builders** — the original tests only encoded
  transfers, which is exactly why a malformed asset-create shipped.
- **The bigint/JSON boundary** — POLO needs bigint, JSON cannot carry it.
  Asserts the raw interaction throws on `JSON.stringify` and the wire form
  does not.
- **Wire shape** — participants, no `funds` block, unprefixed calldata,
  matched against the SDK's own builder.
- **Chain-keyed namespaces** — uses the verbatim payload MOI Wallet returned.
- **Session validity** — expiry in seconds, network mismatch, fixed clock.
- **WalletConnect client** — against a mocked `SignClient`: both param styles,
  user rejection, timeout, and that a malformed interaction reaches the relay
  **zero** times.
- **Project-id diagnostics** — unset, placeholder, wrong-shaped, valid.
- **HTTP read-only** — asserts `http.ts` imports no wallet module and
  registers no write tool.

**Rule going forward:** every bug fixed gets a test that would have caught it.
All ten from the build session have one.

## Tier 2 — live reads against devnet

```bash
npm run test:e2e                    # MOI_E2E=1, TypeScript
./bin/moi-mcp -http :8787 &         # Go, then curl /health and /mcp
```

Gated behind `MOI_E2E=1` so `npm test` stays hermetic. Covers RPC liveness,
typed rejection of a malformed id, the registry logic loading its routines, and
graceful handling of an empty registry.

**Cross-implementation check** — the two must agree. Run the same three reads
through both and diff:

| Read | Expected (as of the last run) |
|---|---|
| `moi_get_account` | nonce 5, 95699 KMOI |
| `moi_get_asset` | KMOI, MAS0, supply 90000000100000, dimension 0 |
| `moi_get_interaction` on `0x3c568254…` | success, 299 fuel |

A divergence means one client is parsing the node wrong — which is precisely
the class of bug that produced the phantom nonce.

## Tier 3 — the wallet path (manual, needs a phone)

No automation reaches this. It is also where every serious bug lived.

**Setup:** real `WC_PROJECT_ID` in `.env`, a devnet account with KMOI,
`npm run build`, `npm run pair`.

| # | Check | Pass |
|---|---|---|
| 1 | `npm run pair` → scan | `session.json` written, `npm run status` shows connected |
| 2 | `moi_transfer` 1 KMOI to self → **Approve** | `{"status":"sent"}` + hash; `moi_get_interaction` says success |
| 3 | `moi_create_asset` `storageFund: 50000` → **Approve** | `{"status":"sent"}`; the new asset resolves via `moi_get_asset` |
| 4 | `moi_transfer` → **Reject** | `{"status":"rejected","reason":"user_rejected"}` |
| 5 | `moi_transfer` → ignore 5 min | `{"status":"rejected","reason":"timeout"}` |
| 6 | Switch wallet network, then write | `network_mismatch`; reads still work |
| 7 | `moi_disconnect_wallet`, then write | `wallet_disconnected` |
| 8 | `moi_create_asset` with default `storageFund` | Refused **locally** with the storage-fund hint; nothing reaches the phone |

**Status: 4 verified, 2, 3, 5, 6, 7 not.** Check 2's mechanism is proven — a
script signed and broadcast twice, one landing at `0x3c568254…` — but never
through the tool with a successful tap. Check 8 is verified by simulation.

**Known-failing, do not treat as a regression:** `moi.sendInteractions` crashes
the wallet's database. We use `moi.signInteraction` and broadcast ourselves. If
that ever starts working, revisit — it is the documented path.

## What CI runs

`.github/workflows/ci.yml`, Node 20/22/24: typecheck, unit tests, build, and
`node dist/cli.js help` — the last because a dangling `bin` breaks `npx`
silently. Tier 2 and 3 stay out of CI deliberately.

## Before any release

```bash
npm run typecheck && npm test && npm run build
npm pack && (cd $(mktemp -d) && npm init -y >/dev/null \
  && npm install <path>/moi-protocol-mcp-server-*.tgz \
  && ./node_modules/.bin/moi-mcp help)
```

Install from the tarball, not the source tree. That is what caught `js-polo`
being a phantom dependency — the build was fine and the published package was
broken.

Then Tier 3 checks 1–3 by hand. Do not ship a write path nobody has approved.
