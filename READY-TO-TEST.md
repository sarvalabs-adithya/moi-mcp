# Ready to test — morning checklist

In order. Every step is safe until §5; §5 pushes real approvals to your phone.
All commands assume `cd ~/moi-mcp` unless stated.

## 0. Session (do this first — it expires 2026-09-02 05:03 UTC)

```bash
cd ~/moi-mcp && npm run status
```

Expected: `Paired with 0x000000001a46…0000 on voyage`, expiry in the future.
If it says not paired / expired: `npm run pair`, scan the terminal QR with MOI
Wallet (voyage network), approve, then `npm run status` again.

## 1. Hermetic checks (no network, no phone)

```bash
npm test                # expect: 13 files, 168 passed | 5 skipped
npm run typecheck       # expect: no output
npm run build           # expect: dist/{index,cli,http,schema}.js rebuilt
```

## 2. Live reads against devnet

```bash
npm run test:e2e        # expect: the 5 gated tests pass (registry loads, empty registry → found:false)
```

## 3. TypeScript vs Go cross-check

```bash
npm run cross-check     # expect: 10-row table, every row "yes", "cross-check: all 10 fields match", exit 0
```

Builds `~/moi-mcp-go/bin/moi-mcp` itself if missing. Nonce 5 / 95699 KMOI are
live values — after §5 lands a transfer they change, and both columns must
change together.

## 4. Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "moi": {
      "command": "node",
      "args": ["/Users/adithyaganesh/moi-mcp/dist/index.js"],
      "env": {
        "MOI_NETWORK": "voyage",
        "WC_PROJECT_ID": "<copy the value from ~/moi-mcp/.env — do not paste it anywhere else>",
        "LOG_LEVEL": "error"
      }
    }
  }
}
```

Quit Claude completely (Cmd-Q, not close window) and reopen. The tool picker
should list 12 `moi` tools. If not: `node dist/index.js` by hand — anything on
stderr is the reason.

## 5. Wallet checks (phone in hand; each prompt is one chat message)

| # | Prompt | Phone | Expected |
|---|---|---|---|
| 1 | `what's my MOI wallet status?` | — | `connected: true`, account `0x…1a46…`, `network: voyage`, `chainId: moi:14`, `configOk: true` |
| 2 | `send 1 KMOI to 0x000000001a46e49490bf4798eb0a09ac3a1fce7773d25ad53158320800000000` | **Approve** | `{"status":"sent","hash":"0x…","explorerUrl":…}`. Then `did that land?` → `status: success` |
| 3 | `create an asset called MCPTEST with supply 1000 and storageFund 50000` | **Approve** | `status: sent` + hash; `look up asset <new id>` → symbol MCPTEST, MAS0 |
| 4 | `send 1 KMOI to <same address>` | **Reject** | `{"status":"rejected","reason":"user_rejected"}` |
| 5 | `send 1 KMOI to <same address>` | ignore 5 min | `{"status":"rejected","reason":"timeout"}` (REQUEST_TIMEOUT_MS=300000) |
| 6 | switch MOI Wallet to another network, then `send 1 KMOI …` | — | `reason: network_mismatch`; `what's in my account?` still answers. Switch back |
| 7 | `disconnect my MOI wallet`, then `send 1 KMOI …` | — | `No wallet was paired`-style text, then `reason: wallet_disconnected`. Re-pair via `npm run pair` |
| 8 | `create an asset called MCPTEST2 with supply 1000` (no storageFund) | nothing arrives | Tool error: "The node says this interaction would fail … Pass a smaller `storageFund`". Already verified; a regression if the phone buzzes |

Between 2 and 3 the sequence number advances; if 3 says "broadcasting it
failed", run it once more. Known: `moi_get_logic` returns `routines: []` for
every logic (`src/moi/reads.ts:240` bug) — do not treat as new.

## 6. Go service

```bash
cd ~/moi-mcp-go && export PATH="/opt/homebrew/bin:$PATH"
go build -o bin/moi-mcp ./cmd/moi-mcp && go test ./... && go vet ./...
./bin/moi-mcp -http :8798 &
curl -s localhost:8798/health      # expect {"ok":true,"version":"0.1.0","network":"voyage",...,"readOnly":true}
curl -s -X POST localhost:8798/mcp -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'   # expect 4 tools
kill %1
```

(The TS HTTP server: `PORT=8787 node dist/http.js` — run the file directly, the
`moi-mcp-http` bin symlink exits silently in 0.1.0, and `/health` returns 503
without `WC_PROJECT_ID`. Both are known bugs, not regressions.)

## 7. If something fails, send me

1. The step number and the exact prompt or command.
2. The tool's full output block from the chat (the JSON or the "MCP error …"
   text), or the terminal output for §1–3/§6.
3. Any `[moi-mcp] …` line from stderr: Claude Desktop → Settings → Developer →
   Open Logs → `mcp-server-moi.log`; for the terminal, it is already on screen.
   The line starting `[moi-mcp] debug: raw wallet error` is the one that
   matters for §5.
4. For §5 failures: what the phone showed (approval screen appeared? error
   toast?) and `npm run status` output afterwards.
5. Do not send the `WC_PROJECT_ID`, `.env`, or `session.json`.
