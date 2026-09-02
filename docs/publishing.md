# Publishing plan

Nothing is published. Neither npm scope is claimed. This is the sequence, the
blockers, and what to deliberately not do yet.

---

## Blocking, in order

**1. Decide the scope name.** `@moi-protocol/mcp-server` and
`@sarvalabs/mcp-server` are both unclaimed. `package.json` currently says
`@moi-protocol`. This is Rahul's call, not a technical one — whoever owns the
npm org owns the release. Claiming the wrong scope is awkward to undo.

**2. Complete the wallet checks.** `docs/testing-plan.md` Tier 3, checks 2–3
(1 is done: a session is paired). Publishing a write path no human has ever
approved through the tool is not defensible; the sign-then-broadcast mechanism
is proven by script and on chain, the tool round-trip is not. `READY-TO-TEST.md`
§5 is the script.

**2a. Fix the two HTTP bugs the tarball test found.** `moi-mcp-http` exits
silently when run through the npm bin symlink (`src/http.ts:162` main-module
guard), and `GET /health` returns 503 without `WC_PROJECT_ID`
(`src/http.ts:107`). Shipping `bin.moi-mcp-http` in that state means
`npx -p @moi-protocol/mcp-server moi-mcp-http` does nothing. Also fix
`moi_get_logic` returning no routines (`src/moi/reads.ts:240`) — it is in the
tool table.

**3. Create the GitHub repo.** `sarvalabs/moi-mcp`. The CLI already points at
its issue tracker, and every directory submission needs a repo URL.

**4. Get a shipped `WC_PROJECT_ID`, or accept that users bring their own.**
Currently required with no default, which is honest but adds a step to every
install. A shared project id would remove it. Rahul's call.

---

## Release sequence

Once those are settled:

```bash
# 1. Verify from the tarball, not the source tree
npm run typecheck && npm test && npm run build
npm pack
cd $(mktemp -d) && npm init -y && npm install <path>/moi-protocol-mcp-server-0.1.0.tgz
./node_modules/.bin/moi-mcp help          # bin must resolve or npx is broken
PORT=8799 ./node_modules/.bin/moi-mcp-http & sleep 2 && curl -s localhost:8799/health; kill %1
                                          # must print {"ok":true,...}; in 0.1.0 as packed it exits silently

# 2. Tag — CI publishes on v*
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/publish.yml` runs typecheck, tests, build, then
`npm publish --access public --provenance` using `NPM_TOKEN`. Add that secret
to the repo before tagging.

**Publish `0.1.0`, not `1.0.0`.** The write path signs on the phone and
broadcasts from the server because the wallet's own sign-and-send crashes.
When `moi.sendInteractions` is fixed the implementation may change, and a 0.x
lets that be a minor bump rather than a breaking one.

### What ships

`dist/`, `README.md`, `docs/`, `examples/`, `.env.example` — 30 files, 183 kB
packed / 669 kB unpacked (last `npm pack`). `scripts/` and `test/` do not ship.
Two binaries: `moi-mcp` (stdio, wallet) and `moi-mcp-http` (read-only).

### The Go service

Separate repo, separate lifecycle. It is a service, not a package — it ships as
a container or binary wherever Voyage runs things, not to npm. Do not couple
the two release trains.

---

## After npm, in this order

**1. A working demo.** `docs/demo-script.md`. Directories convert far better
with one, and it forces the wallet checks to actually pass.

**2. Directory submissions.** Copy is written in `docs/launch/`. Smithery,
Glama, PulseMCP, mcp.so, Cursor. Anthropic's connector directory last — highest
bar, and it wants a real use case.

**3. Announcement.** Blog, X, LinkedIn. Drafts in `docs/launch/`.

---

## Do not do yet

**Directory submissions before a demo exists.** You get one first impression
per directory and a listing with no video converts badly.

**Any announcement claiming mainnet support.** MOI publishes no mainnet RPC URL
or CAIP-2 chain id. Every draft says devnet deliberately — keep it that way.

**Anthropic's connector directory before the use case is settled.** Rahul's
objection — *"you don't really have any big use case as such"* — is unresolved,
and it is the same question a reviewer will ask.

---

## The unresolved thing

Two credible pitches, and they lead to different releases:

- **"MOI needs an MCP endpoint"** — then ship the Go service, host it behind
  Voyage, and the TypeScript one is a reference implementation. Low ceiling,
  and Rahul's objection stands.
- **"This is how an agent touches MOI without holding keys"** — then the
  TypeScript server is the product, the write path is the differentiator, and
  it connects to the agent registry and payments work the team already cares
  about. Higher ceiling, harder sell, needs the demo to land.

Deciding this changes which package gets promoted and what the announcement
says. Decide before publishing, not after.
