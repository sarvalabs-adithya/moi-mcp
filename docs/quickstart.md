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

> send 1 MOI to 0x…

The agent resolves the asset, checks your balance, builds the interaction, and
pushes it to your phone. **Nothing moves until you tap Send.** Reject it and you
get back `{"status":"rejected","reason":"user_rejected"}`. Ignore it for five
minutes and you get `"timeout"`.

> _[screenshot: approval screen, then the interaction hash in chat]_

Then:

> did that interaction land?

## What just happened

Your agent never saw a private key. It read the chain over JSON-RPC, built an
unsigned interaction locally, and sent it over the WalletConnect relay to the
only thing that can sign — your phone.

## Next

- `moi_resolve_agent` finds other agents in the on-chain registry, so your agent
  can discover and pay them.
- `moi_call_logic` with `kind:"view"` reads any deployed logic with no wallet at
  all.
- `moi_get_logic` lists a logic's routines so the agent knows what to call.
