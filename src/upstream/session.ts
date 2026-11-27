/**
 * One tool call's view of the upstream: counts requests (at most 3 per call), classifies responses and logs
 * failures as one JSON line without queries, cursors or request bodies.
 */
import { ToolError } from '../contract/errors';
import { MAX_UPSTREAM_REQUESTS_PER_CALL } from '../contract/limits';
import {
  internalError,
  requestBudgetExhausted,
  upstreamTimeout,
  upstreamTooLarge,
  upstreamUnreachable
} from '../contract/messages';
import { classify, type ClassifyContext, type Outcome } from '../domain/classify';
import { UpstreamError, type UpstreamClient } from './client';
import type { Route, RouteKind } from './routes';

export type LogLine = Record<string, unknown>;

/** An upstream request budget shared by every session of one HTTP request (see MAX_UPSTREAM_REQUESTS_PER_HTTP_REQUEST). */
export type SharedBudget = { readonly limit: number; remaining: number };

/** Upstream bodies on these routes can echo the caller's free-text query, so they are never logged. */
const NO_SNIPPET_ROUTES = new Set<RouteKind>(['search', 'typeahead']);

export type UpstreamSession = {
  fetch(route: Route, context: ClassifyContext): Promise<Outcome>;
};

export function createSession(
  client: UpstreamClient,
  options: { log: (line: LogLine) => void; maxRequests?: number; shared?: SharedBudget; now?: () => number }
): UpstreamSession {
  const maxRequests = options.maxRequests ?? MAX_UPSTREAM_REQUESTS_PER_CALL;
  const now = options.now ?? (() => Date.now());
  const shared = options.shared;
  let requests = 0;

  return {
    async fetch(route, context) {
      if (requests >= maxRequests) {
        options.log({ evt: 'upstream_request_cap', route: route.kind, cap: maxRequests });
        throw internalError();
      }
      if (shared !== undefined && shared.remaining <= 0) {
        options.log({ evt: 'upstream_request_budget', route: route.kind, budget: shared.limit });
        throw requestBudgetExhausted(shared.limit);
      }
      requests++;
      if (shared !== undefined) shared.remaining--;
      const started = now();
      let response;
      try {
        response = await client.get(route);
      } catch (error) {
        const mapped =
          error instanceof UpstreamError
            ? error.kind === 'timeout'
              ? upstreamTimeout()
              : error.kind === 'too_large'
                ? upstreamTooLarge()
                : upstreamUnreachable()
            : internalError();
        options.log({ evt: 'upstream_error', route: route.kind, ms: now() - started, code: mapped.code, kind: errorKind(error) });
        throw mapped;
      }
      try {
        return classify(route.kind, response, context);
      } catch (error) {
        if (error instanceof ToolError) {
          options.log({
            evt: 'upstream_error',
            route: route.kind,
            status: response.status,
            ms: now() - started,
            code: error.code,
            ...(NO_SNIPPET_ROUTES.has(route.kind) ? {} : { snippet: response.snippet })
          });
        }
        throw error;
      }
    }
  };
}

function errorKind(error: unknown): string {
  return error instanceof UpstreamError ? error.kind : 'unknown';
}
