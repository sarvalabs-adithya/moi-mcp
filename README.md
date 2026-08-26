# @moi-protocol/mcp-server

**An MCP server for MOI. It publishes the schema, so an agent can construct the
call.**

That is the whole difference between this and the JSON-RPC endpoint you already
have. With JSON-RPC you must already know the method names, the argument order,
and the payload shape. MCP hands the agent a typed description of every
operation, so it can work out the call itself — including MOI's own vocabulary,
where an interaction is not a transaction and a tesseract is not a block.

Reads need nothing but a network connection. For writes, the agent builds the
interaction and your phone signs it: **this server holds no private keys and
cannot sign.** The only `Signer` class in the codebase throws when asked. That
is not a policy, it is the type system — adding a signing path would mean
writing a new class, not passing a different argument.

```
you: what's in my MOI wallet?
     -> reads the chain directly, no pairing needed

you: send 50 MOI to the agent called pricefeed-01
     -> resolves the agent in the on-chain registry
     -> builds the interaction here
     -> your phone buzzes. nothing moves until you tap Send.
```

## Install

```json
{
  "mcpServers": {
    "moi": {
      "command": "npx",
      "args": ["-y", "@moi-protocol/mcp-server"],
      "env": { "MOI_NETWORK": "voyage", "WC_PROJECT_ID": "<from cloud.reown.com>" }
    }
  }
}
```

Drop that in `claude_desktop_config.json` and restart Claude. Ready-made copies
live in [`examples/`](./examples): Claude Desktop, Cursor, and OpenClaw.

Then pair once, either from the terminal or from inside a chat:

```bash
npx @moi-protocol/mcp-server pair
```

## Tools

| Tool | Wallet needed | What it does |
|---|---|---|
| `ping` | no | Health check: version, network, config status |
| `moi_get_account` | no | Nonce, registration, and every asset balance |
| `moi_get_asset` | no | Symbol, standard, supply, decimal dimension |
| `moi_get_interaction` | no | Status of an interaction by hash |
| `moi_get_logic` | no | A logic's callable routines and their types |
| `moi_resolve_agent` | no | Look up an agent in the on-chain registry |
| `moi_connect_wallet` | — | Returns a QR to scan with MOI Wallet |
| `moi_wallet_status` | — | Paired account, network, expiry, config health |
| `moi_disconnect_wallet` | — | End the session |
| `moi_transfer` | **yes** | Propose an asset transfer |
| `moi_create_asset` | **yes** | Propose creating a new asset |
| `moi_call_logic` | view: no | Call a routine. `view` reads; `invoke` needs approval |

Two resources are exposed too: `moi://networks` and `moi://docs/quickstart`.

## Security model

- **No keys, ever.** The server never generates, stores, or accepts a private
  key or mnemonic. Signing happens on your phone.
- **Reads need no wallet.** Everything read-only works before you pair.
- **Network guard.** If your wallet is on a different network than
  `MOI_NETWORK`, writes are refused with `NETWORK_MISMATCH` rather than sent to
  the wrong chain.
- **Balance pre-check.** Transfers that cannot succeed are rejected locally
  before they reach your phone.
- **`$MOI_MCP_HOME` is `0700`, `session.json` is `0600`.** They hold the
  WalletConnect keystore and session — no key material, but still a handle to a
  wallet.
- **Nothing is auto-approved.** Every write waits for a human tap, and times out
  (default 5 minutes) rather than hanging forever.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `MOI_NETWORK` | `voyage` | `voyage`, `mainnet`, or `custom` |
| `MOI_RPC_URL` | — | Required for `custom` (and for `mainnet`, see below) |
| `WC_PROJECT_ID` | — | **Required.** From [cloud.reown.com](https://cloud.reown.com) |
| `MOI_MCP_HOME` | `~/.moi-mcp` | Session + WalletConnect keystore |
| `MOI_EXPLORER_URL` | `https://voyage.moi.technology` | Used to build explorer links |
| `REQUEST_TIMEOUT_MS` | `300000` | How long to wait for the phone |
| `LOG_LEVEL` | `error` | All logs go to stderr; stdout is the MCP transport |
| `MOI_AGENT_REGISTRY_LOGIC_ID` | (shipped default) | Same variable `js-moi-agent-registry` uses |
| `MOI_READ_CALLER` | — | Participant id used for read-only logic simulation |
| `MOI_WC_PARAM_STYLE` | `positional` | `ix_args` to switch the WalletConnect payload shape |

## Troubleshooting

**"Invalid MOI MCP configuration: WC_PROJECT_ID: Required"** — get a project id
from [cloud.reown.com](https://cloud.reown.com) and put it in the `env` block of
your MCP client config. The server still starts without it so it can tell you
this; reads work, pairing does not.

**"The WalletConnect relay refused the pairing"** — almost always an invalid
`WC_PROJECT_ID`.

**`NETWORK_MISMATCH` on a write** — your wallet and `MOI_NETWORK` disagree.
Switch networks in MOI Wallet, or change `MOI_NETWORK` to match. Reads keep
working either way.

**"The wallet session has expired"** — run `moi-mcp pair` again.

**`moi_resolve_agent` always returns `found:false`** — the registry may have no
entries on your network, or read-only simulation may need a caller identity that
exists on chain. Set `MOI_READ_CALLER` to any real participant id.

**mainnet doesn't work** — MOI has not published a mainnet RPC URL or a
WalletConnect chain id. Use `MOI_NETWORK=custom` with `MOI_RPC_URL` pointed at a
node you can reach.

## Vocabulary

MOI has its own words. Interaction = transaction. Tesseract = block. Logic =
smart contract (written in Cocolang). Fuel = gas. Participant = an account whose
state an interaction may touch, declared up front — the runtime sandboxes
everything else.

## Development

```bash
npm install && npm test && npm run build
```

`npm run inspect` opens the MCP Inspector against the local source.

## License

MIT
