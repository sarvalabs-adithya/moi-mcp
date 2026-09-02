# @moi-protocol/mcp-server

**An MCP server for MOI. It publishes the schema, so an agent can construct the
call.**

That is the whole difference between this and the JSON-RPC endpoint you already
have. With JSON-RPC you must already know the method names, the argument order,
and the payload shape. MCP hands the agent a typed description of every
operation, so it can work out the call itself — including MOI's own vocabulary,
where an interaction is not a transaction and a tesseract is not a block.

Reads need nothing but a network connection. For writes, the agent builds the
interaction here, your phone signs it, and this server broadcasts the signed
bytes to the node: **this server holds no private keys and cannot sign.** The
only `Signer` class in the codebase throws when asked. That is not a policy, it
is the type system — adding a signing path would mean writing a new class, not
passing a different argument.

```
you: what's in my MOI wallet?
     -> reads the chain directly, no pairing needed

you: send 50 KMOI to the agent called pricefeed-01
     -> resolves the agent in the on-chain registry
     -> builds the interaction here, simulates it against the node
     -> your phone buzzes. nothing is signed until you tap Approve.
     -> the signed interaction is broadcast from here; you get the hash
```

## Two transports

| | stdio (local) | HTTP (hostable) |
|---|---|---|
| Tools | all 12 | the 6 read tools |
| Wallet | yes | none |
| Needs `WC_PROJECT_ID` | yes | no (see note) |
| State | WalletConnect session | none |
| Run as | child process of your MCP client | a service behind a URL |

The split is forced by what a wallet needs. A WalletConnect session is a
persistent relay socket and a pending approval waits up to five minutes for a
phone tap — neither survives a stateless request/response service. So writes
stay local, and reads run behind a URL.

The HTTP half imports no wallet code at all, so the write path is unreachable
over the network by construction rather than by configuration.

```bash
PORT=8787 node dist/http.js                          # local build -> http://localhost:8787/mcp
PORT=8787 npx -p @moi-protocol/mcp-server moi-mcp-http   # from npm (see known issues)
curl localhost:8787/health
```

**Known issues in 0.1.0 (HTTP only):** the `moi-mcp-http` bin exits silently
when started through the npm bin symlink, because the main-module guard in
`src/http.ts:162` compares the symlink name to the real file name — run
`node dist/http.js` directly until that is fixed. And `GET /health` returns 503
when `WC_PROJECT_ID` is unset, even though the read tools work without it.

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

The stdio server registers all 12. The HTTP server registers the first six.

| Tool | Wallet needed | What it does |
|---|---|---|
| `ping` | no | Health check: version, network, config status |
| `moi_get_account` | no | Nonce, registration, and every asset balance |
| `moi_get_asset` | no | Symbol, standard, supply, decimal dimension |
| `moi_get_interaction` | no | Status, sender, fuel used, operations of an interaction |
| `moi_get_logic` | no | A logic's routines and their types (see known issues) |
| `moi_resolve_agent` | no | Look up an agent in the on-chain registry |
| `moi_connect_wallet` | — | Returns a QR to scan with MOI Wallet |
| `moi_wallet_status` | — | Paired account, network, expiry, config health |
| `moi_disconnect_wallet` | — | End the session |
| `moi_transfer` | **yes** | Propose an asset transfer |
| `moi_create_asset` | **yes** | Propose a new asset; `storageFund` sets its KMOI funding |
| `moi_call_logic` | view: no, invoke: **yes** | Call a routine. `view` reads; `invoke` needs approval |

Two resources are exposed too: `moi://networks` and `moi://docs/quickstart`.

**`moi_create_asset` and `storageFund`.** A new MOI asset must hold KMOI to pay
for its own storage, so the tool bundles an `ASSET_CREATE` with a KMOI transfer
to the asset id it will get. `storageFund` (base units) defaults to 1,000,000;
if your account holds less than that the simulation refuses locally and tells
you to pass a smaller value. `50000` is plenty on devnet.

**Known issue in 0.1.0:** `moi_get_logic` returns `routines: []` for every
logic, because `src/moi/reads.ts:240` filters manifest elements on
`kind === "routine"` while the manifest names them `"callable"`. Until fixed,
`moi_call_logic` with an unknown routine name still lists the real ones in its
error message.

## Security model

- **No keys, ever.** The server never generates, stores, or accepts a private
  key or mnemonic. Signing happens on your phone.
- **Sign on the phone, broadcast from here.** Writes ask MOI Wallet for
  `moi.signInteraction` (the phone shows the approval screen and returns
  `{ ix_args, signatures }`), then this server submits that to the node's
  `moi.SendInteractions`. The wallet's own sign-and-send method
  (`moi.sendInteractions`) crashes the wallet's local database today — see
  `docs/upstream-issues.md` §1.
- **Reads need no wallet.** Everything read-only works before you pair.
- **Network guard.** If your wallet is on a different network than
  `MOI_NETWORK`, writes are refused with `network_mismatch` rather than sent to
  the wrong chain.
- **Balance and simulation pre-checks.** Transfers that cannot succeed are
  refused locally; every write is simulated against the node (`moi.Call`) and
  refused if the node says it would fail. Nothing that would burn fuel for
  nothing reaches your phone.
- **`$MOI_MCP_HOME` is `0700`, `session.json` is `0600`.** They hold the
  WalletConnect keystore and session — no key material, but still a handle to a
  wallet.
- **Nothing is auto-approved.** Every write waits for a human tap, and times out
  (default 5 minutes) rather than hanging forever.

## Configuration

Every environment variable the server reads. The first eight are validated by
`src/config.ts`; the rest are read where they are used.

| Variable | Default | Notes |
|---|---|---|
| `MOI_NETWORK` | `voyage` | `voyage`, `mainnet`, or `custom` |
| `MOI_RPC_URL` | — | Required for `custom` (and for `mainnet`, see below) |
| `WC_PROJECT_ID` | — | **Required** for the stdio server. From [cloud.reown.com](https://cloud.reown.com), 32 hex chars; placeholders are rejected |
| `MOI_MCP_HOME` | `~/.moi-mcp` | Session + WalletConnect keystore |
| `MOI_EXPLORER_URL` | `https://voyage.moi.technology` | Used to build `explorerUrl` in write results |
| `REQUEST_TIMEOUT_MS` | `300000` | How long to wait for the phone |
| `LOG_LEVEL` | `error` | `silent`, `error`, `info`, `debug`. All logs go to stderr; stdout is the MCP transport |
| `MOI_AGENT_REGISTRY_LOGIC_ID` | (shipped default) | Same variable `js-moi-agent-registry` uses |
| `MOI_READ_CALLER` | — | Participant id used as the caller for read-only logic simulation |
| `MOI_WC_PARAM_STYLE` | `positional` | `ix_args` changes the payload of `moi.sendInteractions` only — the live write path uses `moi.signInteraction` with `params: [ixObject]` regardless |
| `PORT` | `8787` | HTTP server only |

The server also loads a `.env` from its working directory (`dotenv`, quiet
mode). See `.env.example`.

## Troubleshooting

**"WC_PROJECT_ID is not set"** — get a project id from
[cloud.reown.com](https://cloud.reown.com) and put it in the `env` block of
your MCP client config. The server still starts without it so it can tell you
this; reads work, pairing does not.

**"The WalletConnect relay refused the pairing"** — almost always an invalid
`WC_PROJECT_ID`.

**`network_mismatch` on a write** — your wallet and `MOI_NETWORK` disagree.
Switch networks in MOI Wallet, or change `MOI_NETWORK` to match. Reads keep
working either way.

**"The wallet session has expired"** — run `moi-mcp pair` again.

**"The node says this interaction would fail"** — the simulation refused it and
nothing was sent to your phone. The message includes the node's reason; for
`moi_create_asset` it is usually the storage fund exceeding your balance.

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
npm install && npm test && npm run typecheck && npm run build
npm run test:e2e        # live reads against voyage devnet (MOI_E2E=1)
npm run cross-check     # same three reads through this server and ~/moi-mcp-go, diffed
npm run inspect         # MCP Inspector against the local source
npm run pair            # terminal QR; npm run status shows the session
```

`npm test` is hermetic: 168 tests drive the real tool handlers over an
in-memory MCP transport against a fake node and a fake wallet. `docs/testing-plan.md`
lists what each tier covers.

## License

MIT
