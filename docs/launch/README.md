# Phase 4 — distribution

Everything here is **drafted, not executed**. Nothing has been submitted,
posted, published, or emailed. Each item below is a copy-paste-ready asset plus
the action you (a human, with the relevant account) still need to take.

## Blocking on you

| # | Action | Why it needs you |
|---|---|---|
| 1 | `npm publish --access public` | Public + irreversible; needs npm auth for the `@moi-protocol` scope. Or push a `v0.1.0` tag to run `.github/workflows/publish.yml` with `NPM_TOKEN`. |
| 2 | Create the GitHub repo `sarvalabs/moi-mcp` | Decides the scope question and the issue-tracker URL the CLI already points at. |
| 3 | Get a real `WC_PROJECT_ID` | From cloud.reown.com. Pairing cannot be tested without one. |
| 4 | Physically scan a QR with MOI Wallet | The one acceptance check no automation can do. See `../../PLAN.md` Phase 2. |
| 5 | Directory submissions | Each needs an account: Smithery, Glama, PulseMCP, mcp.so, Cursor, Anthropic connectors. Copy in `directory-submissions.md`. |
| 6 | Record + post the demo | Script in `demo-script.md`. |
| 7 | Publish the blog | Draft in `blog-post.md`. |
| 8 | Outreach | Templates in `outreach.md`. |

## Order that actually works

1–3 first (nothing else is real until the package installs from npm). Then 4 —
**do not announce before a real end-to-end send has worked on a phone**, because
the whole pitch is the approval flow. Then 6 and 5 together (directories convert
far better with a demo). 7 and 8 last.

## Do not announce yet if

- The wallet round-trip has never been completed by a human (item 4).
- `MOI_WC_PARAM_STYLE` still needs flipping — that means the wire format
  assumption was wrong and every write is broken.
- mainnet is implied anywhere in the copy. It has no published RPC or chain id.
  All the drafts say devnet deliberately.
