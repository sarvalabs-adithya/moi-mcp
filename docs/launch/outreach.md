# Outreach

**Status: nothing sent.**

## Targets

| Target | Angle | Ask |
|---|---|---|
| LangChain community tools | MCP servers are wrappable as LangChain tools | Listing in the community tools index |
| CrewAI tools | Same | Listing |
| OpenClaw core | Already has MCP support; `examples/openclaw.plugin.md` is written for it | Mention in their MCP docs |
| MOI Builders Session 8 | "Give your agent a MOI wallet" | 20-min live walkthrough |
| Hackathon teams | Removes wallet plumbing from any agent project | Include in the starter kit |

## Template

> Subject: An MCP server where the agent never holds the key
>
> Hi —
>
> I built an MCP server for the MOI network with an unusual constraint: it
> cannot sign. Agents read chain state directly, build transactions locally, and
> hand them to the user's phone over WalletConnect for approval. No private key
> touches the process.
>
> It's MIT, on npm as @moi-protocol/mcp-server, and installs with one JSON block
> in any MCP client.
>
> Given [their project] supports MCP servers, I thought it might be worth a
> listing — happy to open the PR myself if that's easier.
>
> [demo link]
>
> — Adithya

Keep it under 120 words. Lead with the constraint, not the chain.

## Session 8 outline

1. The problem: agents that need to pay for things (2 min)
2. Why a key in an env var is the wrong default (3 min)
3. Live: install, pair, read, pay, approve on the phone (8 min)
4. What's under it: interactions, participants, the registry (5 min)
5. What's unsolved *here*: unattended spending — MOI has MAS0 mandates
   (`Approve`/`TransferFrom`/`Revoke`); this server does not build them yet
   (2 min)

## Metrics — track from day 0

npm weekly downloads · GitHub stars · directory listings live · Session 8
attendance · hackathon teams using it · issues opened by people who are not you
(the real signal).
