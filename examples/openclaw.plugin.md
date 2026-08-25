# Mounting the MOI MCP server in OpenClaw

OpenClaw loads MCP servers as tool providers. Add the server to your OpenClaw
config and its 12 `moi_*` tools become available to any agent in the workspace.

## Config

```jsonc
// ~/.openclaw/config.json
{
  "mcpServers": {
    "moi": {
      "command": "npx",
      "args": ["-y", "@moi-protocol/mcp-server"],
      "env": {
        "MOI_NETWORK": "voyage",
        "WC_PROJECT_ID": "REPLACE_WITH_YOUR_PROJECT_ID",
        // Give each agent its own session directory so they pair independently.
        "MOI_MCP_HOME": "~/.openclaw/moi/<agent-name>"
      }
    }
  }
}
```

Then:

```bash
openclaw plugins list      # moi should appear
openclaw tools list moi    # 12 tools
```

## Pairing in a headless deployment

`moi_connect_wallet` returns a QR as an image block, which a headless runner
cannot display. Pair from the terminal on the host instead:

```bash
MOI_MCP_HOME=~/.openclaw/moi/my-agent \
WC_PROJECT_ID=... \
npx @moi-protocol/mcp-server pair
```

The session is written to `$MOI_MCP_HOME/session.json` and the server picks it
up on next start.

## A caution about autonomy

Every write still requires a human tap on the phone. That is deliberate, and it
means a fully unattended OpenClaw agent **cannot** move funds with this server —
by design, not by oversight. If a write is proposed and nobody approves it, the
request times out after `REQUEST_TIMEOUT_MS` and the tool returns
`{"status":"rejected","reason":"timeout"}`.

Unattended spending would need session keys with spend caps, which MOI does not
yet expose as a primitive. That is tracked as v2 work — do not work around it by
putting a key on the server.

## Suggested agent instructions

```
You can read MOI chain state freely with the moi_get_* tools; they need no
wallet. Before paying an agent, resolve it with moi_resolve_agent and show me
the address you found. Never propose a transfer without telling me the amount,
the asset symbol, and the recipient first. After any transfer, confirm it with
moi_get_interaction.
```
