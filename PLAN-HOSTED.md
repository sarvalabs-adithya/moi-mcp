# MOI connector for Claude — build plan

**Goal.** A hosted MOI connector that anyone adds to Claude chat by pasting a
URL. They sign in, scan a QR once with MOI Wallet, and then talk normally —
*"create 1900 AdiToken"*, *"send 50 KMOI to Adi"*. The connector does the
chain work. The server never holds a key.

- **v1** — every write is signed on the user's phone via WalletConnect.
- **v2** — delegated authority (MAS0 mandates): approve a cap once, the agent
  acts within it without a per-action tap.

This plan is v1, built so v2 is a swap rather than a rewrite.

Sizes assume one engineer who knows this codebase. **Total: 9–12 focused days.
Budget 2–3 weeks.** Everything in §1 and §2 is verified against sources or the
installed code; anything inferred is marked.

---

## 0. Decide before starting

| Decision | Options | Recommendation |
|---|---|---|
| Who runs it | you / Sarva–Voyage | Decide with Rahul. It changes who owns on-call, the domain, and the OAuth issuer. |
| Domain | e.g. `connect.moi.technology` | Needed for OAuth issuer, pairing links, and the connector URL. **Register the exact host** — an apex→www redirect drops the `Authorization` header. |
| Identity provider | see M2 | Verify DCR or CIMD support *before* choosing. Auth settings are immutable once a connector is added. |
| Hosting | the existing MOI VM (nginx + pm2, see §0½ and M6) | The box already terminates TLS for the Explorer API; incremental cost $0. Fly.io single machine is the fallback if SSH/DNS access falls through. Not Vercel / Workers: needs a persistent WebSocket to the WalletConnect relay and requests that wait for a phone. |
| Reown plan | free vs paid | Priced per MAU. Fine at test scale; check the ceiling before launch. |

---

## 0½. Ship reads this week — zero new code

The read-only half is already hostable. `moi-mcp-http` (`dist/http.js`) is
stateless, imports no wallet code, self-fills a dummy `WC_PROJECT_ID`
(`src/http.ts:154`), and serves `/mcp` + `/health`. Put it on the MOI VM
behind nginx and paste the URL into claude.ai as a custom connector. Reads
(accounts, assets, interactions, logics) work in Claude chat immediately;
writes stay local until M1–M5 exist.

On the VM (Node 20+):

    npm i -g @moi-protocol/mcp-server pm2   # or copy the built dist/
    MOI_NETWORK=voyage PORT=8787 pm2 start moi-mcp-http --name moi-mcp
    pm2 save && pm2 startup

nginx, one exact host (e.g. `mcp.moi.technology` — do **not** reuse
`api.agents.moi.technology`, that host is the Explorer API):

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_buffering off;          # streamable HTTP/SSE dies if buffered
        proxy_read_timeout 300s;      # match claude.ai's tool budget
        proxy_send_timeout 300s;
        gzip off;
    }

No redirects on this host — apex→www or http→https redirects strip the
`Authorization` header, which starts to matter the day M2 lands. In
claude.ai: Settings → Connectors → Add custom connector →
`https://mcp.moi.technology/mcp`, auth **None**.

Two caveats:

- Custom connectors have historically required a paid claude.ai plan
  (Pro/Max/Team/Enterprise). If “Add custom connector” isn’t offered on the
  account, that’s why — check in the app, not the docs.
- Auth **None** makes the URL public. It can only read devnet state, but add
  an nginx `limit_req` so a scraper can’t burn the RPC node.

When the write service exists (M2–M6), the same VM fronts it: nginx stays
the TLS terminator, and the Node process must remain a **single always-on
instance** (pm2 `instances: 1`, never cluster mode, never load-balanced) for
the reasons in §4 risk 3.

---

## 1. Three facts that shape the design

**claude.ai allows 300 seconds per tool call.** Not 60. Our 55 s timeout was
calibrated to the SDK's stdio default. A phone tap fits easily; the hosted
transport gets ~240 s. (Source: claude.com/docs/connectors/building,
technical specifications table.)

**One WalletConnect client multiplexes many users.** Sessions are a map keyed
by topic; `connect()` creates an independent pairing per call; `request()`
routes by topic. One process, one relay socket, N users. (Verified in
`@walletconnect/sign-client` 2.23.10 source.)

**The Connectors Directory excludes crypto.** *"Transfer money, cryptocurrency,
or other financial assets"* is an explicit exclusion. So: no listing, no
verified badge, no in-chat suggestion. Distribution is a **pre-filled install
link** you hand people — exactly how MoonPay ships PayBox
(`api.paybox.sh/mcp`, pasted as a custom connector). Whether the restriction
reaches custom connectors is ambiguous; one email to
`mcp-review@anthropic.com` settles it. Send it on day one.

Two more that constrain the UX: claude.ai supports **neither elicitation nor
sampling**, and image tool results are seen by the model but **may not render
to the user** (a reported behaviour, not an Anthropic statement — spike C
below). So the QR cannot be a PNG in the chat.

---

## 2. What carries over

The split is clean: chain logic reused untouched, wallet layer rebuilt for
many users.

| Reuse verbatim | Lines | Why |
|---|---|---|
| `src/moi/*` — building, POLO, simulation, fuel, reads, registry | ~1,366 | zero wallet coupling |
| `src/tools/reads.ts`, `src/resources/*` | ~200 | already multi-user clean |
| `src/errors.ts`, `moi-error.ts`, `json-schema-dialect.ts` | ~250 | transport-agnostic |
| `src/http.ts` | 190 | **keep as the read-only surface; do not extend it** |
| `src/index.ts` (stdio) | — | stays single-user for developers |

| Modify | ~Δ | Change |
|---|---|---|
| `src/wc/client.ts` | 45 | borrow a shared SignClient; delete the session-adoption loop; demux relay events by topic |
| `src/wc/session.ts` | 25 | file path → store interface |
| `src/tools/wallet.ts` | 55 | singleton → per-user map; refuse unauthenticated |
| `src/tools/writes.ts` | 20 | four call sites take the caller's signer |
| `src/config.ts` | 10 | timeout per transport |
| tests | 60 | harness seams |

| New | ~Lines | Purpose |
|---|---|---|
| `src/wc/hub.ts` | 70 | ONE SignClient, ONE socket, ONE `wc.db`; `topic → userId` |
| `src/wc/store.ts` | 70 | `WalletSessionStore` interface + file impl (per-user, 0600); Postgres later |
| `src/server.ts` | 250 | third entry point: Express, OAuth metadata, bearer auth, lazy-auth gate |
| `src/auth/*` | 250–400 | token verification + whichever AS shape M2 lands on |
| `src/pairing/*` | 150 | one-time QR link page |
| `src/journal.ts` | 80 | pending-write records, reconciled on boot |

The single signing seam — `src/tools/writes.ts:172` — is where v1 and v2
differ. Everything else is shared.

---

## 3. Milestones

### M0 — Spikes before any code (1–1.5 days)

Each answers a question that changes the design. No staging exists for
connectors; these run through a tunnel and a throwaway custom connector.

| | Question | How | Pass |
|---|---|---|---|
| A | Does MOI Wallet drop a live session when a *second* pairing arrives? WalletConnect's `cleanupDuplicatePairings` sends `wc_pairingDelete` to every other pairing with the same peer URL — hosted, that is every existing user, on every new pairing. | **One phone is enough.** `npm run pair`, sign. `npm run pair` again from the same phone. Sign with the first session. | First session still signs. **If this fails, stop — nothing above one user works until the wallet is fixed.** |
| B | Is 300 s wall-clock or idle? Do SSE keepalives extend it? | A tool that sleeps 240 s, called from claude.ai. | Returns successfully. Note whether it needed SSE + keepalive. |
| C | Does an image content block reach the *user*? | Return a PNG from a tool on claude.ai. | Yes/no, written down. Decides M4. |
| D | Does the crypto exclusion reach custom connectors? | Email `mcp-review@anthropic.com`. | A reply. Runs in parallel with everything. |

### M1 — Multi-tenancy, entirely local (1.5–2 days)

`hub.ts`, `store.ts`, the six-file edit. No hosting, no OAuth yet.

First hour: **delete the session-adoption loop** in `wc/client.ts` — it grabs
the first parseable session from a shared store and hands it to whoever asks.
Fine for one user; a cross-user signing bug for many.

Then write the failing test before the fix: *user B calling a write against
user A's topic is refused.* This one test matters more than the rest of the
suite.

**Accept:** two simulated users in one process, each with their own session;
both sign concurrently; a `session_delete` for A's topic clears A and leaves B;
B against A's topic is refused.

### M2 — OAuth identity (2–3 days)

Claude needs **one** of: RFC 7591 dynamic client registration, Client ID
Metadata Documents, or a pre-registered client. PKCE S256 on every request.
The server must answer unauthenticated writes with **401** and
`WWW-Authenticate: Bearer error="invalid_token", resource_metadata="…"` —
a 200 with `isError` does *not* trigger sign-in. Serve RFC 9728 protected
resource metadata; the AS serves RFC 8414.

Two viable shapes; **verify before choosing, because auth is immutable once
added:**

1. **External IdP, resource-server only.** ~40 lines: `verifyAccessToken`
   returning `{ token, clientId, scopes, expiresAt }` (seconds — the SDK
   hard-fails otherwise). Only works if the IdP advertises a
   `registration_endpoint` or `client_id_metadata_document_supported: true`.
   Most don't by default. Check the metadata document, not the marketing.
2. **SDK-hosted AS.** `ProxyOAuthServerProvider` + `mcpAuthRouter` + a
   ~10-line `clientsStore.registerClient` (the `/register` route mounts only
   when that exists). More code, no dependency on someone else's DCR support.

Ship **`moi:read` and `moi:write`** scopes from day one, not one opaque scope.
Step-up auth (403 + `insufficient_scope`) is the spec-native home for raising
a cap in v2, and discovery documents are cached ~5 min across all users.

Use **stateless** transport (`sessionIdGenerator: undefined`). Auth is
attached per HTTP request regardless; stateful buys resumability you don't
need inside 300 s and adds a way to sign with the wrong wallet.

**Accept:** MCP Inspector completes the flow. `curl /mcp` with no token → 401
with the header above. `initialize` and `tools/list` succeed unauthenticated;
`moi_transfer` 401s. Every OAuth endpoint answers in under 10 s.

### M3 — Hosted transport (1–1.5 days)

`src/server.ts` on Express 5 (add it as a direct dependency). Lazy-auth gate:
reads public, wallet + write tools behind the 401. Every tool gets `title`,
`readOnlyHint`, `destructiveHint` — with no elicitation, the destructive-tool
prompt plus the wallet screen are the **entire** consent surface.

**Accept:** added to claude.ai by URL. Reads work immediately. A write shows
the inline Connect card, OAuth runs in a popup, and **the same call retries
automatically** with no lost context.

### M4 — Pairing UX (1–1.5 days)

Two constraints, one answer. The QR PNG probably doesn't render, and the raw
`wc:` URI contains a live symKey that would sit in the transcript forever.

`moi_connect_wallet` returns a **short-lived one-time HTTPS link** on your
domain — 5-minute TTL matching the proposal, single use — that renders the QR
and offers a deep link on mobile. No secret in the chat; works on every
surface; a place to show the user what they're connecting.

Make it **idempotent**: a repeat call within the TTL returns the same link.
Each `connect()` burns a pairing, a keypair, and a relay subscription.

**Accept:** a real phone pairs from claude.ai. Repeat call → identical link.
A second user pairs without disturbing the first (spike A, for real).

### M5 — Write path, hosted (1–1.5 days)

`REQUEST_TIMEOUT_MS` → ~240 s **for the hosted transport only**; stdio keeps
55 s. The invariant is unchanged — server budget strictly under the client's —
just derived from the right number.

Add the **write journal**: `{userId, ixHash, state}` written *before* the
WalletConnect request, reconciled on boot. Without it, a restart between
phone-sign and broadcast strands a user who approved something that never
landed and never hears about it. Broadcast idempotent per hash — a retry
never re-asks for a signature. Keep the sign/broadcast split;
`moi.sendInteractions` still crashes the wallet.

**Accept:** *"create 1900 AdiToken"* in claude.ai → phone prompt → real asset
on devnet. Then kill the process between sign and broadcast, restart, confirm
it re-broadcasts or reports honestly. Never silently.

### M6 — Deployment (1–1.5 days)

Default: the same MOI VM that already hosts the reads (§0½). pm2 with
`instances: 1` (never cluster mode), a boot-time lock file that refuses to
start if another instance holds it, `pm2 save && pm2 startup` so it survives
reboots, data root on the VM disk with tightened permissions (§4). Prefer
`pm2 restart` over `pm2 reload` for this service — reload briefly runs two
instances, which is exactly §4 risk 3; a two-second gap is the cheaper
failure. Rate-limit per OAuth subject, not per IP — writes push
notifications to real phones. Strip the paired-account log line.

Fallback if VM access falls through: one Fly.io machine (shared-cpu-1x,
512 MB, ~$3–4/mo), one region, `min_machines_running = 1`,
`auto_stop_machines = "off"`, a volume at the data root,
`strategy = "immediate"`, replicas never above 1.

Cost is flat either way: $0–10/mo at 10, 100, or 1,000 users. The variable
lines are the MOI RPC endpoint and Reown's MAU plan, not compute.

**Accept:** deploy with a live session; after restart it survives and a later
tap still broadcasts. Starting a second instance aborts loudly.

---

## 4. The three risks

**1. `cleanupDuplicatePairings` logs out every existing user.** Verified in
the shipped WalletConnect code; unverified in MOI Wallet's response. If the
wallet cascades pairing-delete into session-delete, nothing above one user
works. *De-risk:* spike A, half an hour, one phone, before any hosting code.

**2. Cross-user signing.** Three live mechanisms today: the adoption loop
grabs the first session in a shared store; the `session_delete` handler
ignores the topic it was given; and a naïve "one SignClient per user" silently
shares storage through a `globalThis` dedupe in `@walletconnect/core`.
*De-risk:* delete the adoption loop in M1's first hour; the B-against-A test;
read `extra.authInfo` on every call and never derive identity from a session
id.

**3. A routine deploy corrupts WalletConnect state.** Two instances briefly
overlapping share the client seed, hence the relay `clientId`; the new one's
subscriber can throw `RESTORE_WILL_OVERRIDE`; every session lives in one file
each writer rewrites wholesale. The default rolling strategy is enough to hit
it. *De-risk:* `strategy = "immediate"` + the lock file on the first deploy.
Fifteen minutes.

Also real, both cheap: the keychain (`topic → symKey`) sits in plaintext at
0644 — possession lets you raise a signing prompt on any paired phone. And
`core/0.3/history` keeps 30 days of every interaction's params in one shared
plaintext file. Tighten permissions; set a retention policy.

---

## 5. v2 — and the v1 decisions that protect it

v2 is `Approve(agent, amount, expires_at)` signed once on the phone; the agent
signs `TransferFrom` within the cap; `Revoke` cancels. Live on devnet today.

**It removes the relay socket from the write path.** The server becomes an
ordinary stateless service — much of M6's hosting scaffolding is around a
constraint v2 deletes. If v2 is within two quarters, do M1 regardless, and
question M3/M6.

**It ends the zero-key property.** "The agent signs" means the server holds
signing material. That is the single strongest thing about this codebase,
and giving it up should be one deliberate, reviewed decision — not a drift.
Simulate-before-sign stops being what makes the wallet screen truthful and
becomes the *only* pre-flight check.

Five things in v1 so v2 isn't a rewrite:

1. Put the seam behind an `InteractionSigner` interface, resolved per user.
   Ten lines now; v2 swaps in a `MandateSigner` without touching a write tool.
2. Ship `moi:read` / `moi:write` scopes (M2) — cap-raising becomes step-up.
3. Version the per-user store record; leave room for `mandates` and `policy`.
4. Ship the journal (M5) — v2 needs the same record for cap accounting.
5. **Leave `ReadOnlySigner` throwing.** No "just for testing" key path.

---

## 6. When not to build this

Ship the local server plus the read-only hosted service instead if any hold:

- **Spike A fails.** Not a judgment call.
- **The audience is under ~50 people and mostly developers.** stdio already
  works with no uptime, custody, or OAuth burden; `http.ts` gives everyone
  else reads today for free. Hosting buys one thing: writes for people who
  won't install Node. Count them honestly.
- **Mandates land within two quarters.** Most of the hosting work is around a
  constraint v2 removes.
- **mcp-review says the exclusion reaches custom connectors.** Then build a
  first-party MOI web app on WalletConnect and reduce the connector to reads.
- **Nobody can own on-call.** An always-on process that can raise a signing
  prompt on N phones, with a plaintext keychain, no staging, and a restart
  window that can strand an approved interaction — that is an operational
  posture, not a side project.

The case *for* building it is real: reads work the instant someone adds the
URL, and the wallet Connect card appears in-conversation at the exact moment
a write is attempted, then the same call retries. That onboarding is
materially better than "install Node, clone, set four env vars." It is a good
case. It is not an unconditional one.

---

## 7. Order of operations

Today: put `moi-mcp-http` on the VM (§0½) — reads live in claude.ai with
zero new code. Send the mcp-review email (D). Run spike A (one phone, 30 min).
This week: M1 — it's pure local refactor, valuable for v2 either way, and it
kills the cross-user bug. Then M2, and only then anything hosted.

Nothing here touches `src/moi/*`, `src/index.ts`, or `src/http.ts`. The
local server and the read-only service keep working throughout.
