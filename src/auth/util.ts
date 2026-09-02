/** Small helpers with no state of their own. */

/** Parse a raw `Cookie` request header into a name -> value map. No cookie-parser dependency. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // Malformed percent-encoding — skip rather than throw on an untrusted header.
    }
  }
  return out;
}

/**
 * RFC 9700 / claude.ai connector requirement: redirect_uris must be https,
 * or http restricted to loopback for local development.
 */
export function isAllowedRedirectUri(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

/** A client_id (or token hash) is used to build a filesystem path — keep it to a safe charset. */
export function isSafePathSegment(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}
