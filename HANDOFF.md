# Handoff

Built overnight, 2026-08-26. Phases 0–3 complete and verified; Phase 4 drafted
but nothing executed; Phase 5 not started (correctly — it's v2 backlog).

## State

| Phase | Status |
|---|---|
| 0 Scaffold | Done, plus your five review fixes |
| 1 Read path | Done. Verified against live voyage devnet |
| 2 WalletConnect + writes | Done. **One check needs your phone** |
| 3 Packaging | Done. **Not published to npm** |
| 4 Distribution | Copy drafted. **Nothing submitted or posted** |
| 5 v2 backlog | Not started, as instructed |

78 unit tests pass. Typecheck clean. Fresh-install from the packed tarball
starts and serves 12 tools + 2 resources.

## The three things blocking you

1. **Scan a QR with MOI Wallet.** Everything up to the relay handshake is
   verified, but no automation can approve on a phone. Needs a real
   `WC_PROJECT_ID` from cloud.reown.com first.
2. **Decide the npm scope and publish.** Both `@moi-protocol` and `@sarvalabs`
   are free. `npm publish --access public`, or push a `v0.1.0` tag.
3. **Answer Q1/Q2/Q3** in `PLAN.md` §7 with Rahul. Q1 is the one that could
   invalidate the write path.

## Read this first, before trusting the write path

The plan assumed WalletConnect takes `{ ix_args: <POLO hex> }`. Evidence says
otherwise: the wallet takes the **plain `InteractionObject`, positionally** —
`params: [ix]`. The `ix_args` POLO form is the *node-level* call the wallet
makes afterwards. Two transports, easy to conflate.

I implemented the evidenced form and left `MOI_WC_PARAM_STYLE=ix_args` as a
one-env-var switch to the other. If the first real send fails, flip it before
debugging anything else.

Because of that, `schema.WcSendInteractionsParams` no longer matches what goes
on the wire. I did not restructure schema.ts. Worth reconciling once Rahul
confirms.

## Four things I'd want a second opinion on

- **`ReadOnlySigner`** (`src/moi/provider.ts`) — the SDK routes read-only logic
  calls through a `Signer`, so this one carries a provider and throws on both
  signing methods. It's how the zero-key invariant is enforced rather than
  documented, but it is a deliberate misuse of an abstract class.
- **Write tools advertise a permissive output shape.** MCP SDK 1.30 can't
  convert a Zod 3 discriminated union to JSON Schema, so they publish the
  superset of `WriteResult`'s three variants and validate against the strict
  union internally. Correct behaviour, looser published contract.
- **`src/moi-error.ts` is a file the plan's layout doesn't have.** It exists so
  `src/moi/*` and `src/wc/*` can throw typed errors without importing
  `errors.ts`, which pulls in the MCP SDK — the rule you set.
- **`moi_resolve_agent` scans.** The registry has no name index, so a
  handle/name lookup pages through up to `MAX_SCAN` (200) profiles and fetches
  HTTP agent cards. Fine while the registry is small; needs an index later.

## Known gaps, stated plainly

- Registry reads return `found:false` on devnet because the logic has no state
  object. Could be an empty registry or the caller-identity issue (new Q7 in
  PLAN.md). Set `MOI_READ_CALLER` to a real participant to test.
- `moi_get_logic` parses the manifest defensively; routine `kind` mapping is
  best-effort and untested against a real Cocolang manifest with view routines.
- Mainnet is unreachable by design — no published RPC or chain id.
- No e2e test exercises a real approved write. That gap closes when item 1 does.

## Commands

```bash
cd ~/moi-mcp && npm test          # 78 tests
npm run typecheck && npm run build
npm run inspect                    # MCP Inspector against source
WC_PROJECT_ID=... node dist/cli.js pair
```
