/**
 * Shared shapes for the OAuth 2.1 authorization server + resource-server
 * verification. `AuthInfo` is the cross-module contract other agents compile
 * against — its field names and units (expiresAt in UNIX SECONDS) are fixed.
 */

/** What `authenticate()` returns for a valid bearer token. */
export interface AuthInfo {
  userId: string;
  clientId: string;
  scopes: string[];
  /** UNIX SECONDS. */
  expiresAt: number;
}

/** A dynamically registered OAuth client (RFC 7591), persisted to disk. */
export interface StoredClientRecord {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none" | "client_secret_post";
  /** sha256 hex of the client secret. Absent for public ("none") clients. */
  clientSecretHash?: string;
  createdAt: string;
}

/** An access or refresh token, persisted under its own sha256 hash. */
export interface StoredTokenRecord {
  kind: "access" | "refresh";
  clientId: string;
  userId: string;
  scopes: string[];
  /** UNIX SECONDS. */
  expiresAt: number;
  /** Links the access/refresh token issued together, for future bulk revocation. */
  pairId: string;
}

/** An issued-but-not-yet-exchanged authorization code, held in memory only. */
export interface PendingCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  userId: string;
  scopes: string[];
  /** Epoch ms — internal to the process, never persisted. */
  expiresAt: number;
  used: boolean;
}
