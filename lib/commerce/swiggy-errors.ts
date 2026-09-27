// Maps raw Swiggy MCP failures to stable error codes.
// TODO(phase0): tighten the message patterns with real strings captured by scripts/spike-swiggy.ts.

export type CommerceErrorCode =
  | "AUTH" // token invalid/expired → owner must re-login
  | "SESSION_419" // MCP session rejected → reconnect with a fresh session
  | "RATE_LIMIT"
  | "MIN_ORDER"
  | "UNSERVICEABLE"
  | "CART_EXPIRED"
  | "OOS"
  | "PAYMENT_DECLINED"
  | "TRANSIENT" // network/5xx/timeout — safe to retry reads
  | "CONFIG" // our own misconfiguration (missing pinned address etc.)
  | "UNKNOWN";

const RETRYABLE: CommerceErrorCode[] = ["TRANSIENT", "RATE_LIMIT", "SESSION_419"];

export class CommerceError extends Error {
  code: CommerceErrorCode;
  status?: number;
  retryable: boolean;
  raw?: unknown;

  constructor(code: CommerceErrorCode, message: string, opts?: { status?: number; raw?: unknown }) {
    super(message);
    this.name = "CommerceError";
    this.code = code;
    this.status = opts?.status;
    this.retryable = RETRYABLE.includes(code);
    this.raw = opts?.raw;
  }
}

export function classifyFailure(status: number | undefined, message: string): CommerceErrorCode {
  const m = message.toLowerCase();
  if (status === 401 || /unauthorized|invalid[_ ]?token|token.*expired|login.*again/.test(m)) return "AUTH";
  if (status === 419 || /session.*(expired|invalid|not found)/.test(m)) return "SESSION_419";
  if (status === 429 || /rate ?limit|too many requests/.test(m)) return "RATE_LIMIT";
  if (/min(imum)? (cart|order)|₹\s*99|order value/.test(m)) return "MIN_ORDER";
  if (/serviceab|not deliver|unable to deliver|location/.test(m)) return "UNSERVICEABLE";
  if (/cart.*(expired|stale|changed|invalid)/.test(m)) return "CART_EXPIRED";
  if (/out of stock|unavailable item|sold out/.test(m)) return "OOS";
  if (/payment|declined|insufficient|balance|wallet/.test(m)) return "PAYMENT_DECLINED";
  if ((status !== undefined && status >= 500) || /timeout|timed out|network|fetch failed|econn|socket|aborted/.test(m)) return "TRANSIENT";
  return "UNKNOWN";
}
