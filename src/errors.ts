/**
 * Maps the string error codes in schema.ErrorCode onto JSON-RPC errors that
 * MCP clients understand, while preserving the string code at `data.code`
 * so an agent can branch on it.
 */

import { McpError, ErrorCode as JsonRpcErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { ErrorCode } from "./schema.js";

/** Which JSON-RPC code best represents each MOI condition. */
const JSONRPC_FOR: Record<ErrorCode, number> = {
  // Bad or unresolvable arguments.
  [ErrorCode.INVALID_ARGS]: JsonRpcErrorCode.InvalidParams,
  [ErrorCode.AGENT_NOT_FOUND]: JsonRpcErrorCode.InvalidParams,
  [ErrorCode.LOGIC_ROUTINE_NOT_FOUND]: JsonRpcErrorCode.InvalidParams,

  // Valid arguments, wrong state — the caller must change something first.
  [ErrorCode.WALLET_NOT_CONNECTED]: JsonRpcErrorCode.InvalidRequest,
  [ErrorCode.NETWORK_MISMATCH]: JsonRpcErrorCode.InvalidRequest,
  [ErrorCode.INSUFFICIENT_BALANCE]: JsonRpcErrorCode.InvalidRequest,
  [ErrorCode.USER_REJECTED]: JsonRpcErrorCode.InvalidRequest,

  // Timing and upstream failures.
  [ErrorCode.REQUEST_TIMEOUT]: JsonRpcErrorCode.RequestTimeout,
  [ErrorCode.RPC_ERROR]: JsonRpcErrorCode.InternalError,
  [ErrorCode.RELAY_UNAVAILABLE]: JsonRpcErrorCode.InternalError,
};

/** Build an McpError carrying the MOI string code in `data.code`. */
export function mcpError(
  code: ErrorCode,
  message: string,
  data?: Record<string, unknown>,
): McpError {
  return new McpError(JSONRPC_FOR[code] ?? JsonRpcErrorCode.InternalError, message, {
    code,
    ...data,
  });
}

/** Throwing form. Use inside tool handlers. */
export function fail(
  code: ErrorCode,
  message: string,
  data?: Record<string, unknown>,
): never {
  throw mcpError(code, message, data);
}

/** Narrow an unknown catch value to a readable message. */
export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}
