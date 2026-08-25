# 60-second demo

**Status: not recorded.** Needs a real `WC_PROJECT_ID`, a funded devnet account,
and a phone on camera.

Record the chat window and the phone side by side. No voiceover needed; the
approval moment carries it.

| Time | On screen | Typed / spoken |
|---|---|---|
| 0:00–0:06 | Claude Desktop, MOI tools visible | "My agent has a MOI wallet. It does not have my keys." |
| 0:06–0:16 | Ask for balance | `what's in my MOI wallet?` — answers instantly, **no pairing** |
| 0:16–0:26 | Resolve an agent | `find the agent called <handle>` — registry hit, address + capabilities |
| 0:26–0:38 | Propose a payment | `pay it 5 <ASSET>` — agent builds the interaction |
| 0:38–0:50 | **Phone buzzes** — hold it up | Silence. Let the approval screen sit. Tap Send. |
| 0:50–0:58 | Hash returns, then confirm | `did it land?` → success + explorer link |
| 0:58–1:00 | End card | "@moi-protocol/mcp-server — the agent never holds the key." |

The whole point is 0:38–0:50. Do not cut it short, do not speed it up.

## Post copy

**X:**
> Most crypto MCP servers ask you to paste a private key into a config file.
>
> This one can't sign anything.
>
> Your agent reads MOI chain state and builds the transaction. Your phone signs it.
>
> npx @moi-protocol/mcp-server
> [video]

**LinkedIn:** same open, then a short paragraph on why key custody is the wrong
default for agent infrastructure, and what changes when approval is a hardware
gesture instead of an env var.
