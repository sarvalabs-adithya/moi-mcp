/** Minimal, dependency-free HTML for the two auth-server pages a browser sees. */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE =
  "font-family:system-ui,-apple-system,sans-serif;max-width:28rem;margin:4rem auto;" +
  "padding:0 1.5rem;color:#1a1a1a;line-height:1.5";

export function renderErrorPage(title: string, detail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head>
<body style="${STYLE}">
<h1 style="font-size:1.25rem">${esc(title)}</h1>
<p>${esc(detail)}</p>
</body></html>`;
}

/** What each scope lets the app do, in the user's terms. */
const SCOPE_MEANING: Record<string, string> = {
  "moi:read": "See which MOI wallet is paired here and its address.",
  "moi:write": "Pair or unpair a wallet, and propose transactions for you to approve on your phone. It cannot move anything without your tap.",
};

export function renderConsentPage(opts: {
  clientName: string;
  scopes: string[];
  /** Origin the browser is sent back to on approval; the one thing a phishing clone cannot fake. */
  redirectOrigin: string;
  formAction: string;
  hidden: Record<string, string>;
}): string {
  const hiddenInputs = Object.entries(opts.hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("\n");
  const scopeList = opts.scopes
    .map((s) => `<li>${esc(SCOPE_MEANING[s] ?? s)}</li>`)
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Authorize ${esc(opts.clientName)}</title></head>
<body style="${STYLE}">
<h1 style="font-size:1.25rem">${esc(opts.clientName)} wants to connect</h1>
<p>After you approve, you will be sent back to <strong>${esc(opts.redirectOrigin)}</strong>. If that is not the app you are using, deny this.</p>
<p>It is asking to:</p>
<ul>${scopeList}</ul>
<p style="color:#555;font-size:0.9rem">Nothing here gives it your keys. Every transaction still needs your approval in MOI Wallet on your phone.</p>
<form method="post" action="${esc(opts.formAction)}" style="display:flex;gap:0.75rem;margin-top:1.5rem">
${hiddenInputs}
<button type="submit" name="decision" value="approve"
  style="flex:1;padding:0.6rem;background:#111;color:#fff;border:none;border-radius:6px;cursor:pointer">Approve</button>
<button type="submit" name="decision" value="deny"
  style="flex:1;padding:0.6rem;background:#eee;color:#111;border:none;border-radius:6px;cursor:pointer">Deny</button>
</form>
</body></html>`;
}
