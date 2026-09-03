/**
 * Express's default error handler prints the stack, with absolute paths, into
 * the response when a body parser rejects malformed JSON. Nobody outside the
 * process needs that. Body-parse failures are the caller's fault and get a
 * plain 400; anything else is ours, logged here and answered with a plain 500.
 */

import type { NextFunction, Request, Response } from "express";

import { log } from "./config.js";

export function cleanErrors(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const e = err as { type?: string; status?: number; message?: string } | undefined;
  if (e && (e.type === "entity.parse.failed" || e.type === "entity.too.large" || e.status === 400 || e.status === 413)) {
    res.status(e.status === 413 ? 413 : 400).json({
      error: e.status === 413 ? "payload_too_large" : "invalid_json",
      error_description: e.status === 413 ? "Request body is too large." : "Request body is not valid JSON.",
    });
    return;
  }
  log("error", `unhandled request error: ${e?.message ?? String(err)}`);
  res.status(500).json({ error: "internal", error_description: "Something went wrong on our side." });
}
