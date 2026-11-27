/**
 * Map an upstream response to a usable body, an empty page, or a curated ToolError (U1-U17).
 * Pure: the same response always classifies the same way, and messages never include upstream bodies or URLs.
 */
import type { ToolError } from '../contract/errors';
import {
  accountContentRestricted,
  accountNotFound,
  accountSuspended,
  invalidSnowflake,
  parameterRejected,
  postNotFound,
  postRestricted,
  proxyPathRejected,
  queryRejected,
  rateLimited,
  searchUnavailable,
  typeaheadUnavailable,
  unexpectedRedirect,
  unexpectedResponse,
  unexpectedStatus,
  upstreamFailed
} from '../contract/messages';
import type { UpstreamResponse } from '../upstream/client';
import type { RouteKind } from '../upstream/routes';

export type ClassifyContext = { postId?: string; handle?: string; q?: string };

export type Outcome = { kind: 'ok'; body: Record<string, unknown> } | { kind: 'empty' };

const LIST_ROUTES = new Set<RouteKind>(['statuses', 'media', 'articles', 'followers', 'following', 'reposts']);
/** Routes where a 404 means "nothing here" rather than an error. */
const EMPTY_ON_404 = new Set<RouteKind>(['statuses', 'media', 'articles', 'followers', 'following', 'search', 'typeahead', 'trends']);
const POST_ROUTES = new Set<RouteKind>(['status', 'reposts']);
const SEARCH_UNAVAILABLE_RE = /search is unavailable/i;

const rec = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function hasExpectedShape(route: RouteKind, body: Record<string, unknown>): boolean {
  switch (route) {
    case 'status':
      return rec(body.status) !== undefined;
    case 'profile':
      return rec(body.user) !== undefined;
    case 'trends':
      return Array.isArray(body.trends);
    case 'typeahead':
      return Array.isArray(body.users) || Array.isArray(body.topics);
    default:
      return Array.isArray(body.results);
  }
}

export function classify(route: RouteKind, response: UpstreamResponse, context: ClassifyContext): Outcome {
  const body = rec(response.body);
  const code = typeof body?.code === 'number' ? body.code : undefined;
  const status = response.status === 200 && code !== undefined && code >= 400 ? code : response.status;
  const message = typeof body?.message === 'string' ? body.message : '';

  if (status === 503 || SEARCH_UNAVAILABLE_RE.test(message)) {
    if (route === 'typeahead') throw typeaheadUnavailable(context.q ?? '');
    if (route === 'search' || SEARCH_UNAVAILABLE_RE.test(message)) throw searchUnavailable(context.q ?? '');
  }
  if (status === 404 && EMPTY_ON_404.has(route)) return { kind: 'empty' };
  if (status >= 300 && status < 400) throw unexpectedRedirect(status);
  if (status >= 200 && status < 300) {
    if (status === 204 && LIST_ROUTES.has(route)) return { kind: 'empty' };
    if (body === undefined || !hasExpectedShape(route, body)) throw unexpectedResponse();
    return { kind: 'ok', body };
  }
  throw failureFor(route, status, body, message, response.headers, context);
}

function failureFor(
  route: RouteKind,
  status: number,
  body: Record<string, unknown> | undefined,
  message: string,
  headers: Headers,
  context: ClassifyContext
): ToolError {
  const postId = context.postId ?? '';
  const handle = context.handle ?? '';
  switch (status) {
    case 400:
      if (body !== undefined && 'allowedPrefix' in body) return proxyPathRejected();
      if (POST_ROUTES.has(route) && message.startsWith('id:')) return invalidSnowflake(postId);
      if (route === 'search' || route === 'typeahead') return queryRejected();
      return parameterRejected();
    case 401:
    case 403:
      return POST_ROUTES.has(route) ? postRestricted(postId, status) : accountContentRestricted(handle, status);
    case 404:
      if (POST_ROUTES.has(route)) return postNotFound(postId, status);
      if (route === 'profile') return body?.reason === 'suspended' ? accountSuspended(handle) : accountNotFound(handle);
      break;
    case 429:
      return rateLimited(parseRetryAfter(headers.get('Retry-After'), Date.now()));
  }
  return status >= 500 ? upstreamFailed(status) : unexpectedStatus(status);
}

/** Retry-After as delta-seconds or an HTTP date, clamped to 1-3600 seconds, defaulting to 60. */
export function parseRetryAfter(value: string | null, now: number): number {
  if (value === null) return 60;
  const trimmed = value.trim();
  let seconds: number;
  if (/^\d+$/.test(trimmed)) seconds = Number(trimmed);
  else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return 60;
    seconds = Math.ceil((at - now) / 1000);
  }
  return Math.min(3600, Math.max(1, seconds));
}
