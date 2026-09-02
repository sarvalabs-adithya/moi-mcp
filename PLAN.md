# MOI MCP Server — Claude Code Build Plan

Work phase by phase. Each phase ends with acceptance checks you can run.

## 0. Goal

Ship `@moi-protocol/mcp-server`: an MCP server that lets Claude / Cursor / OpenClaw agents read MOI chain state and propose transactions that are signed on the user's phone via MOI Wallet (WalletConnect v2). The server holds zero private keys.

Non-goals for v1: browser-extension (`window.moi`) path, x402 helpers, delegated / autonomous mode. These are v2. (A read-only HTTP transport was pulled forward and shipped as `dist/http.js`; see Phase 5.)

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
* Writes never touch a key. They build an interaction, simulate it, hand it to WC for `moi.signInteraction`, and broadcast the returned `{ ix_args, signatures }` to the node's `moi.SendInteractions` themselves.
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
│  ├─ http.ts               # read-only streamable HTTP entry (6 tools, stateless)
│  ├─ moi-error.ts          # MoiError, so moi/* and wc/* never import the MCP SDK
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
├─ scripts/
│  └─ cross-check.mjs       # same reads through this server and ~/moi-mcp-go, diffed
└─ test/
   ├─ helpers/              # in-process JSON-RPC fake node, MCP harness, fake wallet
   ├─ unit/                 # ix-builder, session, config, + tool handlers end to end
   └─ e2e/                  # devnet reads (MOI_E2E=1)
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

## Phase 1 — Read path (≈8h) — DONE

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

## Phase 2 — WalletConnect + write path (≈12h) — DONE via sign + broadcast

Shipped shape differs from the task list below in one way: step 4 is
`wc.signInteraction(session, ix)` (WalletConnect method `moi.signInteraction`,
`params: [ixObject]`) followed by `provider.sendInteraction({ ix_args, signatures })`
from this process, because the wallet's own `moi.sendInteractions` crashes its
SQLite database (`docs/upstream-issues.md` §1). Every write is also simulated
(`moi.Call`) and fuel-estimated before it reaches the phone. The paired session
exists and the mechanism is proven on chain; the only thing not yet done through
the tools is a successful tap (`READY-TO-TEST.md` §5).

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
   4. build ix → estimate fuel → simulate → `wc.signInteraction(session, ix)` → `provider.sendInteraction(signed)` *(superseded the original `moi.sendInteractions` call; see the note above)*
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

## Phase 3 — Packaging + client configs (≈4h) — DONE except npm publish

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

## Phase 4 — Distribution (≈8h, non-code) — DRAFTED, NOTHING EXECUTED

* Submit: Smithery, Glama, PulseMCP, mcp.so, Cursor directory, Anthropic connector directory.
* 60-sec Loom: connect → resolve agent → pay agent → hash. Post on X + LinkedIn.
* MOI Builders Session 8: "Give your agent a MOI wallet."
* Blog on moi.technology (GEO-optimised): "The first MCP server where the agent never holds keys."
* Outreach: LangChain community tools, CrewAI tools, OpenClaw core.

Track from day 0: npm weekly downloads, GH stars, directory listings, Session 8 attendance, hackathon teams using it.

## Phase 5 — v2 backlog (do not start in v1)

* Streamable HTTP transport, read-only — **shipped early** as `dist/http.js` (6 tools, stateless) and as the Go service in `~/moi-mcp-go`. Hosting at `mcp.moi.technology` still open.
* `moi.signInteraction` mode — **became the v1 write path** (wallet bug forced it). Batching on top of it is still v2.
* MCP Apps widget: in-chat transaction card with live status.
* x402 helpers: `moi_pay_agent(handle, amount)` = resolve + transfer + receipt.
* Delegated / capped mode for unattended agents. MOI's native pieces: MAS0 mandates (`Approve`/`TransferFrom`/`Revoke`, amount + expiry), account keys (`ACCOUNT_CONFIGURE`, weighted co-signing), access policies (`ACCESS_*`, storage-only today). A `moi_transfer_from` tool plus a `moi.Mandates` read is the cheap first step; anything richer needs a policy Logic. See `docs/findings.md` §6.
* `window.moi` extension path for browser-based agents.

## 6. Claude Code operating rules

* Never write SDK calls without reading the installed `.d.ts` first.
* Never log to stdout.
* Never store, print, or accept a mnemonic or private key anywhere in this repo. If a task seems to need one, stop and ask.
* Keep `src/moi/*` and `src/wc/*` free of `@modelcontextprotocol/sdk` imports.
* Every tool handler validates input with the zod schema from `schema.ts` and returns the matching output shape.
* After each phase: run tests, run inspector smoke, print the tree, stop.

## 7. Open questions — status

Five of the seven are answered from shipped code, public sources, or the real
wallet. Two are decisions, not research (5 and 6).

**1. Exact `ix_args` encoding — ANSWERED, confirmed against the real wallet.**
There are two different transports and the plan conflated them.
- *WalletConnect (us → wallet)*: the plain `InteractionObject`, passed
  positionally as `params: [ix]`. Confirmed: MOI Wallet accepts
  `moi.signInteraction` with exactly that and returns `{ ix_args, signatures }`.
  Source for the shape: `sarvalabs/wallet-connect-dapp`
  `src/contexts/JsonRpcContext.tsx`.
- *Node JSON-RPC (us → node)*: `moi.SendInteractions` with the wallet's
  `{ ix_args, signatures }`, where `ix_args` is POLO-encoded **unprefixed** hex.
  Confirmed on chain: `0x3c568254d339090d1e0ec256f9ac46fe288aab7d7739275e2267ddff3fdbc009`.
- *The twist*: the wallet's combined `moi.sendInteractions` (sign + broadcast)
  accepts the same positional payload and then crashes on its own SQLite
  `NOT NULL` constraint. So we sign on the phone and broadcast from here.
`MOI_WC_PARAM_STYLE` only affects the unused `sendInteractions` path now.

**2. CAIP-2 chain ids — PARTLY ANSWERED.**
`moi:14` for devnet (`sarvalabs/wallet-connect-dapp` `src/chains/moi.ts`:
`{ name: "Moi devnet", id: "moi:14", rpc: [...], slip44: 614 }`).
**Mainnet: NOT FOUND anywhere public.** `NETWORKS.mainnet.caip2Verified` is
false and pairing on mainnet will fail. Needs Rahul.

**3. `meta.description` on the approval screen — ANSWERED: meta is not sent.**
The positional `moi.signInteraction` payload has no slot for it, and the wallet
renders the approval screen from the interaction itself (operations, amounts,
participants). `signInteraction()` accepts a `description` argument and ignores
it. Nothing to confirm unless the wallet adds a metadata field.

**4. Canonical agent-registry logic id — ANSWERED.**
`0x20000000c684f926ed158d0cbfe66af0e482a389393e7899a5a73fcb00000000`, hardcoded
in `js-moi-agent-registry` `lib.cjs/client.js`, overridable with
`MOI_AGENT_REGISTRY_LOGIC_ID`. We reuse that exact variable name. The logic
loads on devnet (manifest fetches; 14 callable elements, 11 routines via
`getLogicDriver`) but has no state object yet, so reads answer "not found".
Note `moi_get_logic` currently reports zero routines for it — our bug
(`src/moi/reads.ts:240` looks for kind `"routine"`, the manifest says
`"callable"`), not the registry's.

**5. npm scope — STILL YOURS.** Both `@moi-protocol/mcp-server` and
`@sarvalabs/mcp-server` are unclaimed. Currently set to `@moi-protocol`.

**6. Shared `WC_PROJECT_ID` — STILL YOURS.** Required, no default shipped. The
server starts without it and says so rather than dying.

**7. Which participant should read-only simulation use? — STILL OPEN.**
`getLogicDriver` routes read calls through a Signer and the node resolves that
caller's account meta info, so a placeholder identity gets "account not found".
`MOI_READ_CALLER` overrides it and stays as the supported workaround. The
protocol question — a canonical read-only caller per network, or simulation
not requiring a resolvable sender — is for the MOI team.
