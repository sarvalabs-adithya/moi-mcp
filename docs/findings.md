# Findings

What building `@moi-protocol/mcp-server` turned up about MOI's integration
surface. Written for someone deciding whether this is sound, not for someone
reading a changelog.

---

## 1. Two transports carry an interaction, and they are easy to conflate

The build spec assumed the wallet receives `{ ix_args }`, where `ix_args` is a
POLO-encoded hex string. That is real — but it belongs to a different hop.

| | dapp → MOI Wallet | MOI Wallet → node |
|---|---|---|
| Transport | WalletConnect relay | JSON-RPC |
| Method | `moi.sendInteractions` | `moi.SendInteractions` (capital S, I) |
| Payload | plain `InteractionObject`, positional: `params: [ix]` | `{ ix_args, signatures }` |
| Encoding | JSON | POLO hex, **unprefixed** |

The evidence for the left column is `sarvalabs/wallet-connect-dapp`
(`src/contexts/JsonRpcContext.tsx`), which passes `await builder.ixData(sender)`
— typed `Promise<InteractionObject>` — straight into `params`. The evidence for
the right column is `js-moi-wallet`'s `signInteraction`, which returns
`{ ix_args: bytesToHex(serializeIxObject(ix)), signatures: ... }`.

The method names differ only in casing, which is how the two get mixed up.

**Resolution.** We send the left form. `schema.ts` §4 models both, with the
citations inline, and `MOI_WC_PARAM_STYLE=ix_args` switches to the right form
with no code change. `client.ts` validates outgoing params against the schema,
so a malformed interaction fails locally with a readable message rather than as
a confusing rejection on someone's phone.

**Residual risk.** No public document gives a literal request body for
`moi.sendInteractions`; the authoritative reference the wallet docs link to
(`sarvalabs/moi-wallet-mobile/Dapp-docs`) is private. Until a real send is
approved on a real phone, the left column is a well-evidenced inference, not a
confirmed fact. If the first send fails, flip the variable before debugging
anything else.

**Worth fixing at the source:** publishing one literal example request in the
public wallet docs would close this permanently.

---

## 2. Mainnet has no published CAIP-2 id or public RPC — an ecosystem gap

This is not a bug in this server, and not something we can work around.

- **CAIP-2.** The only MOI chain id attested anywhere public is `moi:14`, for
  devnet, in `sarvalabs/wallet-connect-dapp` `src/chains/moi.ts`
  (`{ name: "Moi devnet", id: "moi:14", slip44: 614 }`). No mainnet id exists in
  any repo, doc, or the CAIP-2 registry.
- **RPC.** `js-moi-sdk` hardcodes exactly one endpoint,
  `https://dev.voyage-rpc.moi.technology/devnet/`, and `VoyageProvider` accepts
  only the string `"devnet"` — anything else throws. Every plausible mainnet
  hostname fails DNS or 404s.
- A `Chain` enum exists in `js-moi-utils` (`TEST_NET=111`, `DEV_NET=112`,
  `MAIN_NET=113`), but nothing in `js-moi-sdk` or `go-moi` consumes it, and its
  values don't line up with `moi:14`. It looks vestigial.

**What we did.** `NETWORKS.mainnet` carries `rpcUrl: null` and
`caip2Verified: false`, and the CLI warns before attempting to pair on an
unverified chain. `MOI_NETWORK=custom` with `MOI_RPC_URL` is the supported path
to any node.

**Consequence for launch.** Every piece of demo and launch copy says devnet
deliberately. Nothing should imply mainnet works until an id and an endpoint are
published — a third-party integrator hitting this would have no way to proceed.

---

## 3. The agent registry's logic id is already pinned in a shipped package

`js-moi-agent-registry@0.3.0-rc1` hardcodes it in `lib.cjs/client.js`:

```js
exports.LOGIC_ID = process.env.MOI_AGENT_REGISTRY_LOGIC_ID
  ?? '0x20000000c684f926ed158d0cbfe66af0e482a389393e7899a5a73fcb00000000';
```

We reuse that exact environment variable name, so both libraries can be pointed
at a new deployment together rather than drifting apart.

**Status on devnet.** The logic exists — its manifest fetches and it exposes 11
routines including `GetAgentProfile`, `GetAllAgentIds`, `GetAgentCount`. But
calling any of them fails with `state object fetch failed: failed to fetch acc
meta info: account not found`, so the registry has no state object yet.

We treat that as an empty registry and return `{"found": false}` rather than an
error — an agent that isn't registered is a normal answer, not a server fault.
The practical effect is that `moi_resolve_agent` cannot demo well on devnet
until something is registered.

**Note:** `AgentRegistry.init()` requires a `Signer` with keys even for reads,
which is unusable from a zero-key process. We go through `getLogicDriver`
directly instead. A read-only constructor in that package would be a small,
useful change.

---

## 4. Read-only logic calls need a caller identity that exists on chain

`getLogicDriver` routes even read-only calls through a `Signer`, because the
node resolves the *caller's* account meta info in order to simulate. A synthetic
placeholder identity is rejected with "account not found".

This is a sharper edge than it looks: it means a pure read can fail for reasons
that have nothing to do with what is being read.

`MOI_READ_CALLER` overrides the identity with any participant id that exists on
the network. We also short-circuit `getNonce()` — a simulation consumes no
sequence number, and asking the node for a placeholder's nonce fails the same
way.

**Open question for the protocol team:** is there a canonical read-only caller
on each network, or should simulation not require a resolvable sender at all?

---

## 5. Zero-key is enforced by the type system, not by convention

The security claim is that no code path leads from a tool call to a private key.
That is easy to say and easy to erode.

Because the SDK insists on a `Signer` for reads (§4), the temptation is to hand
it a real wallet. Instead, `src/moi/provider.ts` defines `ReadOnlySigner`, which
extends the SDK's abstract `Signer`, carries a provider, and throws on both
signing methods:

```ts
async sign(): Promise<string> {
  throw new MoiError(
    ErrorCode.WALLET_NOT_CONNECTED,
    "This MCP server holds no private keys. Signing happens in MOI Wallet on your phone.",
  );
}
```

The only `Signer` in the codebase cannot sign. Adding a signing path would mean
writing a new class, not passing a different argument — which is the point.

Supporting the same invariant: `ix-builder.ts` stops at the unsigned
`InteractionObject`, and `toPoloHex()` proves encoding and signing are separable
by producing the wallet's exact `ix_args` bytes without a key. `$MOI_MCP_HOME`
is `0700` and `session.json` is `0600`; neither holds key material, but both are
handles to a wallet.

**Honest cost.** An agent using this server cannot spend unattended — every
write waits for a human tap and times out after five minutes. For a fleet of
agents paying each other, that is a real limitation.

The fix is not a hot key on the server. MOI already has the primitive: MAS0
**mandates** (`Approve{beneficiary, amount, expires_at}` → the agent signs
`TransferFrom` with its own key → `Revoke`), amount- and expiry-bounded and
live on devnet today. Exposing them would need three new tools; see §6.

---

## 6. MOI already has amount- and expiry-bounded delegation; access policies are not it

The obvious place to look for "let an agent spend up to X" is the access-policy
machinery, because it is the thing named like a permission system. That is the
wrong place, and the difference is worth stating precisely — this server does
not ship the tools yet, but the primitive is not missing from MOI.

**Mandates are the delegation primitive, and they carry a budget.**
`js-moi-asset/src.ts/mas0.ts:53-57` declares

```ts
export interface Approve {
    beneficiary: Uint8Array;
    amount: number | bigint;
    expires_at: number;
}
```

`TransferFrom` (the `MAS0.Endpoint.TRANSFERFROM` member at `mas0.ts:4`, shaped
at `mas0.ts:32-36` as `{ benefactor, beneficiary, amount }`) and `Revoke`
(`mas0.ts:11`) close the loop: the owner **Approves** a beneficiary for an
`amount` until an `expires_at`, the agent signs **TransferFrom** with its own
key, and the owner can **Revoke** at any time. The cap is per asset, bounded by
amount *and* by expiry, and it is live on devnet today.

**Access policies are storage-only and have no amount field.**
`js-moi-utils/lib.esm/schema.js:202-232` gives `accessPolicySchema` as exactly

```
{ resource, resource_id, actions, scope { prefixes, predicate(null) } }
```

— `resource` and `actions` are integers, `resource_id` and the scope prefixes
are bytes, and `predicate` is a reserved nil slot that must still be encoded so
later fields do not misalign. There is no amount anywhere in it, and no expiry.
A policy can say *which keys of which resource may be written*; it cannot say
*how much may be spent*.

**And only one resource type is live.** `js-moi-utils/lib.esm/enums.js:44-50`
defines `ResourceType` as `STORAGE(1)`, `ASSET(2)`, `LOGIC(3)`, `KEY(4)`, and
the comment immediately above it states that only `STORAGE` is implemented on
the network today — `ASSET`/`LOGIC`/`KEY` are reserved values that validate
locally and are rejected server-side. So even the resource types that sound
like spending controls do not exist on chain yet.

**What §5 is pointing at, then**, is three new write tools plus one read:

| Tool | Operation |
|---|---|
| `moi_approve` | MAS0 `Approve{beneficiary, amount, expires_at}` |
| `moi_transfer_from` | MAS0 `TransferFrom{benefactor, beneficiary, amount}` |
| `moi_revoke` | MAS0 `Revoke` |
| a `moi.Mandates` read | show the caller what is currently delegated |

Not anything built on `ACCESS_CREATE`/`ACCESS_UPDATE`/`ACCESS_DELETE`
(`js-moi-utils` `enums.js` `OpType` 18/19/20), which cannot express a budget.
Do not invent an `amount` or `expires_at` field on `AccessPolicy`: it has
neither.

The honest limit of mandates is that one mandate is a single cap per asset —
no per-transaction limit, no rate. Richer policy than that still needs a Logic.

---

## Summary for the protocol team

| Finding | Ours to fix | Theirs to fix |
|---|---|---|
| Two transports, no public example request | modelled + switchable | publish one literal `moi.sendInteractions` body |
| No mainnet CAIP-2 or public RPC | flagged, degrades cleanly | publish both |
| Registry logic id | reuse their env var | — |
| Registry has no state on devnet | returns `found:false` | register something, or confirm expected |
| Reads need a resolvable caller | `MOI_READ_CALLER` | canonical read caller, or drop the requirement |
| `AgentRegistry.init` needs keys for reads | bypassed | read-only constructor |
