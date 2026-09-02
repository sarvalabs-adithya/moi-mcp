/**
 * OAuth 2.1 authorization server + resource-server verification for the
 * hosted MCP endpoint, built for what claude.ai's custom-connector flow
 * requires: RFC 8414 + RFC 9728 metadata, RFC 7591 dynamic client
 * registration, PKCE-required authorization codes (RFC 9700), and bearer
 * token verification.
 *
 * Hand-rolled rather than built on the SDK's server/auth/* helpers: their
 * OAuthServerProvider abstraction assumes redirect-based authorize() with no
 * room for the cookie-identified consent screen this spec requires, and its
 * AuthInfo shape ({token, clientId, scopes, expiresAt?, resource?}) doesn't
 * match the {userId, clientId, scopes, expiresAt} contract other modules in
 * this repo compile against. Reimplementing the provider to bridge that gap
 * would be more code than routing Express directly. The dependency budget
 * here (express + node:crypto/node:fs only) rules out importing them anyway.
 */

import type { Express } from "express";
import type { IncomingHttpHeaders } from "node:http";
import { join } from "node:path";

import { loadOrCreateCookieSecret, sha256Hex } from "./crypto.js";
import { mountAuthRoutes } from "./routes.js";
import { ClientStore, CodeStore, TokenStore } from "./store.js";
import type { AuthInfo } from "./types.js";

export type { AuthInfo } from "./types.js";

export interface MountAuthOptions {
  publicUrl: string;
  dataDir: string;
}

export interface AuthHandle {
  authenticate(req: { headers: IncomingHttpHeaders }): AuthInfo | undefined;
  challengeHeader(): string;
}

export function mountAuth(app: Express, opts: MountAuthOptions): AuthHandle {
  const publicUrl = opts.publicUrl.replace(/\/+$/, "");
  const cookieSecret = loadOrCreateCookieSecret(join(opts.dataDir, "auth", "cookie-secret"));
  const clientStore = new ClientStore(opts.dataDir);
  const tokenStore = new TokenStore(opts.dataDir);
  const codeStore = new CodeStore();
  const cookieSecure = publicUrl.startsWith("https://");

  mountAuthRoutes(app, { publicUrl, clientStore, tokenStore, codeStore, cookieSecret, cookieSecure });

  function authenticate(req: { headers: IncomingHttpHeaders }): AuthInfo | undefined {
    const header = req.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    if (!value || !value.startsWith("Bearer ")) return undefined;
    const token = value.slice("Bearer ".length).trim();
    if (!token) return undefined;

    const hash = sha256Hex(token);
    const record = tokenStore.get(hash);
    if (!record || record.kind !== "access") return undefined;
    if (record.expiresAt < Math.floor(Date.now() / 1000)) {
      tokenStore.delete(hash);
      return undefined;
    }
    return { userId: record.userId, clientId: record.clientId, scopes: record.scopes, expiresAt: record.expiresAt };
  }

  function challengeHeader(): string {
    return `Bearer error="invalid_token", error_description="Authorization required", resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"`;
  }

  return { authenticate, challengeHeader };
}
