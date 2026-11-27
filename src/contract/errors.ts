import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type ErrorCode =
  | 'invalid_argument'
  | 'invalid_cursor'
  | 'not_found'
  | 'restricted'
  | 'feature_unavailable'
  | 'rate_limited'
  | 'timeout'
  | 'upstream_unavailable'
  | 'internal';

export type ToolErrorSpec = {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  hint: string;
  retryAfterSeconds?: number;
  upstreamStatus?: number;
};

/** An expected, agent-facing failure. Its message and hint are curated and never contain upstream bodies or URLs. */
export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly hint: string;
  readonly retryAfterSeconds: number | undefined;
  readonly upstreamStatus: number | undefined;

  constructor(spec: ToolErrorSpec) {
    super(spec.message);
    this.name = 'ToolError';
    this.code = spec.code;
    this.retryable = spec.retryable;
    this.hint = spec.hint;
    this.retryAfterSeconds = spec.retryAfterSeconds;
    this.upstreamStatus = spec.upstreamStatus;
  }
}

export type ErrorPayload = {
  error: string;
  code: ErrorCode;
  retryable: boolean;
  hint: string;
  retry_after_seconds?: number;
  upstream_status?: number;
};

export function errorPayload(error: ToolError): ErrorPayload {
  const payload: ErrorPayload = { error: error.message, code: error.code, retryable: error.retryable, hint: error.hint };
  if (error.retryAfterSeconds !== undefined) payload.retry_after_seconds = error.retryAfterSeconds;
  if (error.upstreamStatus !== undefined) payload.upstream_status = error.upstreamStatus;
  return payload;
}

export function errorResult(error: ToolError): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(errorPayload(error)) }] };
}
