# Draft: "The MCP server that can't sign"

**Status: not published.** Target: moi.technology blog.

**Slug:** `mcp-server-that-cannot-sign`
**Meta:** An MCP server for MOI where the agent never holds a private key. Reads
go straight to the chain; every write is approved on your phone over
WalletConnect.

---

## The default is wrong

Almost every blockchain MCP server begins the same way: put a private key in an
environment variable. It is understandable — the agent needs to sign, signing
needs a key, so the key goes where the agent is.

It is also the wrong default. An MCP server runs on a laptop, inside a client
you did not write, exposed to whatever text an agent happens to read that day.
Prompt injection against a process holding a hot key is not a hypothetical
attack; it is the obvious one.

## The alternative

Split what the agent needs from what the agent must never have.

An agent needs to *read* — balances, assets, interaction status, what routines a
logic exposes, which agents are registered. None of that needs a key. And it
needs to *propose* — construct a valid, well-formed transaction. That does not
need a key either. Only the last step does, and that step is exactly the one a
human should be looking at.

So: the server reads the chain directly and builds the interaction locally, then
sends it over WalletConnect to MOI Wallet on your phone. You see the amount and
the recipient on a screen the agent cannot draw on. You tap Send, or you don't.

Concretely, in `@moi-protocol/mcp-server` the only `Signer` in the codebase
throws when asked to sign:

```ts
async sign(): Promise<string> {
  throw new MoiError(
    ErrorCode.WALLET_NOT_CONNECTED,
    "This MCP server holds no private keys. Signing happens in MOI Wallet on your phone.",
  );
}
```

That class exists because the SDK routes read-only logic calls through a signer
— it needs an identity to simulate against. Rather than weaken the invariant, it
is enforced by the type system. There is no code path from a tool call to a key,
because there is no key.

## What it looks like

```
you: what's in my MOI wallet?
     -> answered from the chain. no pairing needed.

you: send 50 MOI to the agent called pricefeed-01
     -> resolves it in the on-chain registry
     -> checks your balance
     -> builds the interaction
     -> your phone buzzes
```

Reject it and the tool returns `{"status":"rejected","reason":"user_rejected"}`.
Ignore it and after five minutes you get `"timeout"`. Have your wallet on the
wrong network and the write is refused locally with `NETWORK_MISMATCH` before it
ever reaches the relay.

## What this costs

Honesty matters more than the pitch: **an agent using this server cannot spend
money unattended.** Every write waits for a human. For a fleet of autonomous
agents paying each other, that is a real limitation, not a feature.

The answer is not to put the key back. MOI already has the primitive: MAS0
mandates. The owner `Approve`s a beneficiary for an amount until an
`expires_at`, the agent signs `TransferFrom` with its own key, and the owner can
`Revoke` at any time — amount- and expiry-bounded, live on devnet today. This
server does not build `TransferFrom` yet, and a mandate is a single cap per
asset with no per-transaction limit or rate, so richer policy still needs a
Logic. Until those tools land here, unattended spending is unsolved in **this
server**, not in MOI — and a hot key is not a solution to it either way.

## Try it

```bash
npx @moi-protocol/mcp-server pair
```

Then add it to Claude Desktop or Cursor: [quickstart](../quickstart.md).

---

_Facts to re-verify before publishing: devnet-only status, the exact tool count,
and the current state of MAS0 mandate tooling._
