#!/usr/bin/env node
/**
 * Two users, one server, one phone.
 *
 * The open question this answers: when a second person pairs, does MOI Wallet
 * keep the first person's pairing alive? WalletConnect sends a delete to other
 * pairings from the same app during cleanup, and if the wallet cascades that
 * into dropping the session, multi-user breaks at the wallet and no amount of
 * server code fixes it. Everything else about multi-user is proven in tests
 * with simulated users; this is the part only a real wallet can answer.
 *
 * You do not need two phones. Two server-side users with two separate pairings
 * is the condition being tested, and one phone can hold both.
 *
 * Usage:
 *   node scripts/two-user-spike.mjs [baseUrl]
 *
 * Nothing here signs or broadcasts anything. It pairs twice and then reports
 * whether both sessions are still alive. The final signing check is left to
 * you, because that is the part that buzzes a real phone.
 */

import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";

const BASE = (process.argv[2] ?? "http://localhost:8788").replace(/\/$/, "");
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** One independent user: its own cookie jar is what makes the server treat it
 *  as a different person, exactly as two browsers would. */
class User {
  constructor(label) {
    this.label = label;
    this.cookies = new Map();
    this.token = null;
  }

  get cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  absorb(res) {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  async fetch(path, init = {}) {
    const headers = { ...(init.headers ?? {}) };
    if (this.cookies.size) headers["cookie"] = this.cookieHeader;
    const res = await fetch(BASE + path, { ...init, headers, redirect: "manual" });
    this.absorb(res);
    return res;
  }

  async signIn() {
    const reg = await (
      await this.fetch("/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: [REDIRECT],
          client_name: `spike ${this.label}`,
          token_endpoint_auth_method: "none",
        }),
      })
    ).json();

    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash("sha256").update(verifier).digest());
    const query = new URLSearchParams({
      response_type: "code",
      client_id: reg.client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "moi:read moi:write",
      state: this.label,
    });

    const page = await (await this.fetch(`/authorize?${query}`)).text();
    const action = /<form[^>]*action="([^"]*)"/.exec(page)?.[1] || "/authorize/decision";
    const fields = new URLSearchParams();
    for (const [, name, value] of page.matchAll(/name="([^"]+)"[^>]*value="([^"]*)"/g)) {
      fields.set(name, value);
    }
    fields.set("decision", "approve");

    const decided = await this.fetch(action.startsWith("http") ? new URL(action).pathname : action, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: fields.toString(),
    });
    const code = new URL(decided.headers.get("location"), BASE).searchParams.get("code");
    if (!code) throw new Error(`${this.label}: no authorization code`);

    const tok = await (
      await this.fetch("/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          client_id: reg.client_id,
          code_verifier: verifier,
        }).toString(),
      })
    ).json();
    this.token = tok.access_token;
    return this;
  }

  async call(tool, args = {}) {
    const res = await this.fetch("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
    });
    const text = await res.text();
    if (res.status !== 200) return { httpStatus: res.status, text };
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : text).result ?? {};
  }

  async walletStatus() {
    const r = await this.call("moi_wallet_status");
    return r.structuredContent ?? r;
  }
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log(`\nServer: ${BASE}\n`);

const alice = await new User("alice").signIn();
const bob = await new User("bob").signIn();
console.log("Two separate users signed in.\n");

const aliceLink = (await alice.call("moi_connect_wallet")).structuredContent;
console.log("USER ONE — open this and scan it with MOI Wallet:");
console.log(`  ${aliceLink?.url}\n`);
await rl.question("Press enter once the first wallet is connected... ");

const first = await alice.walletStatus();
console.log(`  user one connected: ${first.connected}${first.address ? ` (${first.address.slice(0, 18)}...)` : ""}\n`);
if (!first.connected) {
  console.log("First pairing did not complete, so there is nothing to test yet. Stopping.");
  rl.close();
  process.exit(1);
}

const bobLink = (await bob.call("moi_connect_wallet")).structuredContent;
console.log("USER TWO — open this and scan it with the SAME phone:");
console.log(`  ${bobLink?.url}\n`);
await rl.question("Press enter once the second wallet is connected... ");

const aliceAfter = await alice.walletStatus();
const bobAfter = await bob.walletStatus();

console.log("\n--- result ---");
console.log(`  user one still connected: ${aliceAfter.connected}`);
console.log(`  user two connected:       ${bobAfter.connected}`);
console.log(`  different sessions:       ${first.address !== undefined && aliceAfter.address === first.address}`);

if (aliceAfter.connected && bobAfter.connected) {
  console.log("\nPASS. A second pairing did not disturb the first, so the server can");
  console.log("hold several users at once.");
  console.log("\nOne thing left, and it needs your thumb: ask Claude to do a transfer");
  console.log("as user one and confirm the prompt still arrives. A session that reads");
  console.log("as connected but no longer signs would look identical here.");
} else if (!aliceAfter.connected) {
  console.log("\nFAIL. The second pairing dropped the first user's session.");
  console.log("This is a wallet-side behaviour, not something the server can work");
  console.log("around: multi-user cannot work until MOI Wallet keeps concurrent");
  console.log("sessions alive. Worth raising with whoever owns the wallet.");
} else {
  console.log("\nINCONCLUSIVE. The second pairing did not complete.");
}

rl.close();
