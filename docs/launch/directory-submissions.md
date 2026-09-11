# Directory submissions

**Status: none submitted.** Each requires an account.

## Shared fields

- **Name:** MOI
- **Package:** `@moi-protocol/mcp-server`
- **Repo:** `https://github.com/sarvalabs/moi-mcp` _(create first)_
- **License:** MIT
- **Transport:** stdio
- **Category:** Blockchain / Crypto / Wallets

**One-liner (≤100 chars):**
> Let your agent read MOI chain state and propose transactions you approve on your phone.

**Short description (≤300 chars):**
> An MCP server for the MOI network. Agents read accounts, assets, interactions,
> logics, and the on-chain agent registry directly. Writes are built locally and
> signed in MOI Wallet over WalletConnect — the server holds zero private keys.

**Long description:** reuse README's opening plus the Security model section.

**Tags:** `moi`, `blockchain`, `wallet`, `walletconnect`, `web3`, `agent-payments`, `on-chain-identity`

## Per-directory notes

| Directory | URL | Notes |
|---|---|---|
| Smithery | smithery.ai | Wants a `smithery.yaml`. Needs `WC_PROJECT_ID` declared as a required config field. |
| Glama | glama.ai/mcp/servers | Auto-indexes public GitHub repos with an MCP manifest — often just needs the repo to exist and be tagged `mcp`. |
| PulseMCP | pulsemcp.com | Manual submission form. |
| mcp.so | mcp.so | Manual submission form. |
| Cursor directory | cursor.com/directory | Wants the `.cursor/mcp.json` snippet — already in `examples/cursor.mcp.json`. |
| Anthropic connectors | Via the MCP directory process | Highest bar; do this last, after the demo exists. |

## The angle to lead with

Most blockchain MCP servers take a private key in an env var. This one cannot
sign at all — the only `Signer` in the codebase throws. That is the
differentiator; put it in the first sentence everywhere.
