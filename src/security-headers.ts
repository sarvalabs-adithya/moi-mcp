/**
 * Response headers every page and endpoint should carry.
 *
 * The consent page and the pairing page are the two places a person makes a
 * decision in a browser, which makes them the two places clickjacking would
 * pay off: frame the page, overlay a fake button, and the click lands on
 * Approve. frame-ancestors 'none' and X-Frame-Options DENY close that in
 * every browser. The rest are the usual defaults that cost nothing.
 */

import type { NextFunction, Request, Response } from "express";

export function securityHeaders(publicUrl: string | undefined) {
  const hsts = (publicUrl ?? "").startsWith("https://");
  return function headers(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      // Pages here are self-contained: inline style and a few lines of inline
      // script for the copy button, nothing loaded from anywhere else.
      "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (hsts) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  };
}
