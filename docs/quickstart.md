# Give your agent a MOI wallet in 5 minutes

## 1. Get a WalletConnect project id (1 min)

Sign in at [cloud.reown.com](https://cloud.reown.com), create a project, copy
the project id. This is what lets your machine and your phone find each other
through the WalletConnect relay. It is not a secret key.

## 2. Add the server to your client (1 min)

**Claude Desktop** — edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "moi": {
      "command": "npx",
      "args": ["-y", "@moi-protocol/mcp-server"],
      "env": { "MOI_NETWORK": "voyage", "WC_PROJECT_ID": "paste-it-here" }
    }
  }
}
```

Restart Claude. `moi` should appear in the tools list with 12 tools.

**Cursor** — same block in `.cursor/mcp.json`. See `examples/cursor.mcp.json`.

> _[screenshot: the MOI tools listed in the client's tool picker]_

## 3. Read something (30 sec)

No pairing needed yet. Ask:

> what MOI networks can you reach?

The agent reads `moi://networks`. Then try a real account:

> look up MOI account 0x…

## 4. Pair your phone (2 min)

> connect my MOI wallet

A QR code appears in the chat. Open MOI Wallet on your phone, scan it, approve.

> _[screenshot: QR in chat, MOI Wallet approval screen]_

Prefer the terminal? `npx @moi-protocol/mcp-server pair` prints the same QR.

Confirm it landed:

> what's my MOI wallet status?

## 5. Send something (30 sec)

> send 1 KMOI to 0x…

The agent resolves the asset, checks your balance, builds the interaction,
simulates it against the node, and pushes it to your phone. **Nothing is signed
until you tap Approve.** The phone returns the signature; the server broadcasts
it and hands you the hash. Reject it and you get back
`{"status":"rejected","reason":"user_rejected"}`. Ignore it for five minutes and
you get `"timeout"`.

Creating a token works the same way — `create an asset called MCPTEST with
supply 1000`. A new asset must hold some KMOI to pay for
its own storage; the default is 1,000,000, so pass a smaller `storageFund` on a
small devnet balance.

> _[screenshot: approval screen, then the interaction hash in chat]_

Then:

> did that interaction land?

## What just happened

Your agent never saw a private key. It read the chain over JSON-RPC, built an
unsigned interaction locally, sent it over the WalletConnect relay to the only
thing that can sign — your phone — and then submitted the signed bytes to the
node itself. The server relays a signature; it never produces one.

## Next

- `moi_resolve_agent` finds other agents in the on-chain registry, so your agent
  can discover and pay them.
- `moi_call_logic` with `kind:"view"` reads any deployed logic with no wallet at
  all.
- `moi_get_logic` lists a logic's routines so the agent knows what to call.
