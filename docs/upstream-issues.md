# Three issues in the MOI stack

Found while building an MCP server against voyage devnet, 2026-08-26. Each is
reproducible and each blocks any third-party integrator, not just us. Filed
here so they can be raised independently of anything else.

Environment: `js-moi-sdk@0.8.0`, `js-moi-agent-registry@0.3.0-rc1`,
MOI Wallet mobile over WalletConnect v2, RPC
`https://dev.voyage-rpc.moi.technology/devnet/`, chain `moi:14`.

---

## 1. `moi.sendInteractions` crashes MOI Wallet's local database

**Severity: blocks the documented write path entirely.**

Sending an interaction over WalletConnect with `moi.sendInteractions` fails
every time with a SQLite error leaking out of the wallet:

```
Failed to create interaction: Calling the 'finalizeAsync' function has failed
→ Caused by: Error code 19: NOT NULL constraint failed:
  interactions_metadata.number_of_operations
```

**This is not a malformed payload.** It reproduces with an interaction built by
the SDK's own builder — the same class `sarvalabs/wallet-connect-dapp` uses in
`src/contexts/JsonRpcContext.tsx`:

```ts
const ix = await new MAS0AssetLogic(KMOI_ASSET_ID, signer)
  .transfer(recipient, 1)
  .ixData({ sender: { id: account, key_id: 0, sequence } });

await client.request({
  topic, chainId: "moi:14",
  request: { method: "moi.sendInteractions", params: [ix] },
});
```

The same interaction simulates cleanly against the node (`moi.Call` →
`receipt.status: 0`, `fuel_used: 0x12b`), and the identical payload signs and
broadcasts successfully via the workaround below. So the interaction is valid;
the wallet fails while writing its own metadata row.

**Workaround:** use `moi.signInteraction` and broadcast the returned
`{ ix_args, signatures }` yourself via the node's `moi.SendInteractions`. That
path works — confirmed on chain at
`0x3c568254d339090d1e0ec256f9ac46fe288aab7d7739275e2267ddff3fdbc009`
(status 0, 299 fuel).

**Note:** a dapp should never see a SQLite constraint error. Even once the
underlying cause is fixed, a validation failure would be more useful than an
internal DB error.

---

## 2. `AccountState.nonce` is declared in the SDK types but never returned

**Severity: silent wrong values, hard to trace.**

`js-moi-providers` declares:

```ts
export interface AccountState {
    nonce: string;
    // ...
}
```

The node does not return that field. `provider.getAccountState(id).nonce` is
`undefined`, which any reasonable numeric coercion turns into `0` — so an
account that has transacted several times reports a nonce of 0, and the wallet
then rejects the interaction with **"invalid nonce"**.

The type is what makes this expensive: it asserts a field exists, so nobody
thinks to check, and the failure surfaces two layers away as a wallet
rejection.

**Correct source**, and what the SDK's own `Signer.getNonce()` uses:

```ts
await provider.getPendingInteractionCount(id, keyId)
```

**Suggested fix:** mark it optional (`nonce?: string`) or remove it. Either
makes the compiler surface the problem at the call site.

---

## 3. `AgentRegistry.init()` requires a private key to perform reads

**Severity: unusable from any keyless process.**

```ts
export interface SDKConfig {
    wallet: Signer;      // required
    uploader?: CardUploader;
}
static init(config: SDKConfig): Promise<AgentRegistry>;
```

`getAgentProfile`, `getAgentsByOwner`, `getAllAgentIds` and `getAgentCount` are
all read-only, but the class cannot be constructed without a `Signer`. Anything
that deliberately holds no keys — an indexer, a public API, an MCP server —
cannot use the package for reads at all.

**Workaround:** bypass the class and call `getLogicDriver(LOGIC_ID, signer)`
with a Signer that carries a provider and throws on both signing methods.

**Suggested fix:** accept a provider, or add a `AgentRegistry.readOnly(provider)`
constructor that exposes only the query methods.

---

## Two smaller notes

**Registry has no state on devnet.** The logic at
`0x20000000c684f926ed158d0cbfe66af0e482a389393e7899a5a73fcb00000000`
loads its manifest and exposes 11 routines, but every routine call fails with
`state object fetch failed: failed to fetch acc meta info: account not found`.
Presumably nothing has been registered yet — worth confirming that is expected
rather than a deployment problem.

**Read-only logic calls need a caller that exists on chain.** `getLogicDriver`
routes reads through a `Signer`, and the node resolves that caller's account
meta info, so a synthetic identity fails. A read failing for reasons unrelated
to what is being read is surprising. Is there a canonical read-only caller, or
should simulation not require a resolvable sender?

---

## Also worth knowing

`moi.sendInteractions` (wallet, camelCase) and `moi.SendInteractions` (node,
PascalCase) differ only in casing and do different things on different
transports. That is a genuine trap; naming them distinctly would help.
