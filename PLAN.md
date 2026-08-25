# MOI MCP Server — Claude Code Build Plan

Work phase by phase. Each phase ends with acceptance checks you can run.

## 0. Goal

Ship `@moi-protocol/mcp-server`: an MCP server that lets Claude / Cursor / OpenClaw agents read MOI chain state and propose transactions that are signed on the user's phone via MOI Wallet (WalletConnect v2). The server holds zero private keys.

Non-goals for v1: HTTP transport, browser-extension (`window.moi`) path, x402 helpers, session keys / autonomous mode. These are v2.

## 1. Architecture

```
Claude / Cursor / OpenClaw
        │  stdio (JSON-RPC, MCP)
        ▼
┌───────────────────────────────────────────┐
│ @moi-protocol/mcp-server (Node ≥ 20)      │
│                                           │
│  tools/read/*   ──► moi/provider.ts ──────┼──► MOI RPC (voyage | mainnet)
│  tools/write/*  ──► moi/ix-builder.ts     │
│                     └─► wc/client.ts ─────┼──► WalletConnect relay ──► MOI Wallet (phone)
│  wc/session.ts  (~/.moi-mcp/session.json) │                              │ user taps Send
│                                           │◄─────── hash ────────────────┘
└───────────────────────────────────────────┘
```

Rules:

* `src/moi/*` and `src/wc/*` have no MCP imports. They must be reusable as a plain TS lib.
* Writes never touch a key. They build an interaction, hand it to WC, await the hash.
* Session chain must equal `MOI_NETWORK` or the write is refused with `NETWORK_MISMATCH`.

## 2. Repo layout

```
moi-mcp/
├─ PLAN.md
├─ README.md
├─ package.json
├─ tsconfig.json
├─ .env.example
├─ src/
│  ├─ index.ts              # stdio entry; registers tools from schema.TOOLS
│  ├─ cli.ts                # `moi-mcp pair` / `moi-mcp status` (terminal QR)
│  ├─ config.ts             # loads + validates env via schema.Config
│  ├─ schema.ts             # PROVIDED — do not restructure
│  ├─ errors.ts             # McpError helpers keyed by schema.ErrorCode
│  ├─ moi/
│  │  ├─ provider.ts        # js-moi-providers wrapper, network→RPC map
│  │  ├─ reads.ts           # getAccount, getAsset, getInteraction, getLogic
│  │  ├─ registry.ts        # resolveAgent (agent registry logic calls)
│  │  └─ ix-builder.ts      # buildTransfer, buildCreateAsset, buildLogicInvoke
│  ├─ wc/
│  │  ├─ client.ts          # SignClient init, pair(), request(), disconnect()
│  │  ├─ session.ts         # load/save/validate ~/.moi-mcp/session.json
│  │  └─ qr.ts              # uri → PNG base64 (qrcode) + terminal (qrcode-terminal)
│  ├─ tools/
│  │  ├─ wallet.ts          # connect / status / disconnect
│  │  ├─ reads.ts           # 5 read tools
│  │  └─ writes.ts          # transfer / create_asset / call_logic
│  └─ resources/
│     └─ index.ts           # moi://networks, moi://docs/quickstart
├─ examples/
│  ├─ claude-desktop.json
│  ├─ cursor.mcp.json
│  └─ openclaw.plugin.md
├─ docs/
│  └─ quickstart.md
└─ test/
   ├─ unit/                 # ix-builder, session, config
   └─ e2e/                  # devnet reads; write path mocked WC
```

## 3. Dependencies

```
runtime:  @modelcontextprotocol/sdk  zod  @walletconnect/sign-client
          @walletconnect/utils  js-moi-sdk  qrcode  qrcode-terminal  dotenv
dev:      typescript  tsx  vitest  @types/node  @types/qrcode  tsup
```

Claude Code: before writing any SDK call, run `npm view js-moi-sdk version` and `cat node_modules/js-moi-sdk/dist/index.d.ts | head -200` (and the sub-packages `js-moi-providers`, `js-moi-utils`, `js-moi-manifest`). Do not guess SDK method names from memory — read the types and adapt.

## 4. Environment (`.env.example`)

```
MOI_NETWORK=voyage
# MOI_RPC_URL=https://...        # only for MOI_NETWORK=custom
WC_PROJECT_ID=REPLACE_ME          # cloud.reown.com, ship a default in package
MOI_MCP_HOME=~/.moi-mcp
REQUEST_TIMEOUT_MS=300000
LOG_LEVEL=error
```

All logging goes to stderr (stdout is the MCP transport).

## Phase 0 — Scaffold (≈2h) — DONE

Tasks

* `npm init`, TS strict, ESM, `tsup` build to `dist/`, `bin: { "moi-mcp": "dist/cli.js" }`.
* `src/config.ts`: parse env with `schema.Config`, expand `~`, create `MOI_MCP_HOME`.
* `src/index.ts`: `McpServer` + `StdioServerTransport`; register a `ping` tool.
* `src/errors.ts`: `fail(code, message)` → `McpError` with `data.code`.
* Vitest configured; one passing test for config.

Accept

* `npx tsx src/index.ts` starts, responds to MCP `initialize` (use `npx @modelcontextprotocol/inspector`).
* `npm test` green.

## Phase 1 — Read path (≈8h)

Tasks

* `moi/provider.ts`: `getProvider(network)` → JsonRpc provider. Network map: `voyage → <devnet RPC>`, `mainnet → <mainnet RPC>`, `custom → MOI_RPC_URL`. Pull URLs from docs.moi.technology.
* `moi/reads.ts`: implement 4 reads returning `schema.*Output` shapes exactly. Normalise amounts to decimal strings using asset `dimension`.
* `moi/registry.ts`: `resolveAgent(query)`. Use the agent-registry logic from the MOI Builders Session 2 spec (Adithya owns this). Accept handle, name, or address. Return `found:false` (not throw) on miss.
* `tools/reads.ts`: 5 tools. Descriptions must be agent-friendly, e.g. `moi_resolve_agent`: "Look up an AI agent in the MOI agent registry by handle, name, or address. Use before paying or calling an agent."
* `resources/index.ts`: `moi://networks` (JSON), `moi://docs/quickstart` (markdown).

Accept

* Inspector: `moi_get_account` on a known devnet address returns balances.
* `moi_resolve_agent("<known handle>")` returns address + capabilities.
* Unit tests for amount normalisation (dimension 0, 6, 18).

## Phase 2 — WalletConnect + write path (≈12h)

Tasks

* `wc/session.ts`: load/save `schema.SessionStore`; `isValid()` checks expiry + chain.
* `wc/client.ts`:
   * `init()` — `SignClient.init({ projectId, metadata: {name:"MOI MCP Server", url:"https://moi.technology", ...}, storageOptions: { database: <MOI_MCP_HOME>/wc.db } })`.
   * `pair(network)` → `connect({ requiredNamespaces })` using `schema.WcRequiredNamespaces`; returns `{ uri, approval }`. On approval, persist session.
   * `request(method, params)` — `client.request({ topic, chainId, request:{method, params} })` wrapped in `Promise.race` with `REQUEST_TIMEOUT_MS` → `REQUEST_TIMEOUT`.
   * Map WC user-rejection error → `USER_REJECTED`.
   * Restore session on startup; subscribe `session_delete` / `session_expire` → clear store.
* `wc/qr.ts`: `toPng(uri)` (base64), `toTerminal(uri)`.
* `moi/ix-builder.ts`: build unsigned interaction objects for transfer / create asset / logic invoke using js-moi-sdk. Output the exact `ix_args` shape MOI Wallet expects (confirm encoding in Dapp-docs; default assumption: the same object shape the SDK passes to `moi.SendInteractions` JSON-RPC, minus signature).
* `tools/wallet.ts`:
   * `moi_connect_wallet` → if valid session: `already_connected`. Else pair, return `[image(png), text(uri)]`, and spawn background await on approval (don't block the tool). Tool result says "scan, then call moi_wallet_status".
   * `moi_wallet_status`, `moi_disconnect_wallet`.
* `tools/writes.ts`: each write =
   1. assert session valid else `WALLET_NOT_CONNECTED`
   2. assert `session.network === config.MOI_NETWORK` else `NETWORK_MISMATCH`
   3. for transfer: pre-check balance via reads → `INSUFFICIENT_BALANCE`
   4. build ix → `wc.request("moi.sendInteractions", { ix_args, meta:{description} })`
   5. return `schema.WriteResult` + `explorerUrl`
   * `moi_call_logic` with `kind:"view"` bypasses wallet and calls provider directly.
* `cli.ts`: `moi-mcp pair` prints terminal QR and waits; `moi-mcp status`.

Accept

* `moi-mcp pair` → scan with MOI Wallet mobile → session.json written.
* Inspector: `moi_transfer` on devnet → phone shows approval → tap Send → hash returned; `moi_get_interaction(hash)` shows success.
* Reject on phone → `{status:"rejected", reason:"user_rejected"}`.
* Ignore on phone 5 min → `{status:"rejected", reason:"timeout"}`.
* Switch wallet network → `NETWORK_MISMATCH` on write; reads still work.
* Unit tests: ix-builder shapes; session validity; WC client with mocked SignClient.

## Phase 3 — Packaging + client configs (≈4h)

Tasks

* `README.md`: 30-second pitch, install, `examples/*` configs, tool table (from `schema.TOOLS`), security model (zero keys, phone approval, network guard), troubleshooting (relay, project id, session expired).
* `docs/quickstart.md`: "Give your agent a MOI wallet in 5 minutes" — numbered, screenshots placeholders.
* `examples/claude-desktop.json`:

```json
{ "mcpServers": { "moi": { "command": "npx", "args": ["-y", "@moi-protocol/mcp-server"],  "env": { "MOI_NETWORK": "voyage" } } } }
```

* `examples/cursor.mcp.json` (same shape), `examples/openclaw.plugin.md` (how to mount as OpenClaw tool).
* `npm publish --access public` under `@moi-protocol` (or `@sarvalabs`; decide with Rahul).
* GitHub Actions: lint, test, build on PR; publish on tag.

Accept

* Fresh machine: paste claude-desktop.json → restart Claude → "connect my MOI wallet" → QR appears in chat → scan → "what's my balance" works → "send 1 MOI to <addr>" pops on phone.

## Phase 4 — Distribution (≈8h, non-code)

* Submit: Smithery, Glama, PulseMCP, mcp.so, Cursor directory, Anthropic connector directory.
* 60-sec Loom: connect → resolve agent → pay agent → hash. Post on X + LinkedIn.
* MOI Builders Session 8: "Give your agent a MOI wallet."
* Blog on moi.technology (GEO-optimised): "The first MCP server where the agent never holds keys."
* Outreach: LangChain community tools, CrewAI tools, OpenClaw core.

Track from day 0: npm weekly downloads, GH stars, directory listings, Session 8 attendance, hackathon teams using it.

## Phase 5 — v2 backlog (do not start in v1)

* Streamable HTTP transport, read-only, hosted at `mcp.moi.technology`.
* `moi.signInteraction` mode (sign-only, server broadcasts; enables batching).
* MCP Apps widget: in-chat transaction card with live status.
* x402 helpers: `moi_pay_agent(handle, amount)` = resolve + transfer + receipt.
* Session-key / spend-cap mode for unattended agents (needs MOI primitive).
* `window.moi` extension path for browser-based agents.

## 6. Claude Code operating rules

* Never write SDK calls without reading the installed `.d.ts` first.
* Never log to stdout.
* Never store, print, or accept a mnemonic or private key anywhere in this repo. If a task seems to need one, stop and ask.
* Keep `src/moi/*` and `src/wc/*` free of `@modelcontextprotocol/sdk` imports.
* Every tool handler validates input with the zod schema from `schema.ts` and returns the matching output shape.
* After each phase: run tests, run inspector smoke, print the tree, stop.

## 7. Open questions for Rahul (answer before Phase 2)

1. Exact `ix_args` encoding MOI Wallet expects on `moi.sendInteractions` (POLO hex vs JSON)?
2. CAIP-2 chain ids for voyage / mainnet in the WC namespace?
3. Does the wallet honour a `meta.description` field for the approval screen? If not, what does it display?
4. Which agent-registry logic id is canonical on voyage right now?
5. npm scope: `@moi-protocol` or `@sarvalabs`? Repo under `sarvalabs/` with Adithya as maintainer?
6. Can we get a shared `WC_PROJECT_ID` to ship as default?
