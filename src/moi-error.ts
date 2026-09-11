/**
 * Framework-free error type shared by src/moi/* and src/wc/*.
 *
 * PLAN rule: those directories must stay free of @modelcontextprotocol/sdk so
 * they remain usable as a plain TS library. They therefore cannot import
 * errors.ts (which builds McpError). They throw MoiError instead, and
 * tools/* converts it at the boundary via errors.ts#toMcpError.
 */

import { ErrorCode } from "./schema.js";

export class MoiError extends Error {
  readonly code: ErrorCode;
  readonly data: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.name = "MoiError";
    this.code = code;
    this.data = data;
  }
}

export function isMoiError(err: unknown): err is MoiError {
  return err instanceof MoiError;
}

/** Wrap an unknown upstream failure as an RPC_ERROR without losing the cause. */
export function asRpcError(err: unknown, context: string): MoiError {
  const detail = err instanceof Error ? err.message : String(err);
  return new MoiError(ErrorCode.RPC_ERROR, `${context}: ${detail}`, { cause: detail });
}
