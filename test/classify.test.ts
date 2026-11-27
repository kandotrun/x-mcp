import { describe, expect, it, vi } from 'vitest';
import { ToolError } from '../src/contract/errors';
import { classify, parseRetryAfter } from '../src/domain/classify';
import { createSession } from '../src/upstream/session';
import type { UpstreamClient, UpstreamResponse } from '../src/upstream/client';
import { UpstreamError } from '../src/upstream/client';
import { routes, type RouteKind } from '../src/upstream/routes';
import badSnowflake from './fixtures/error-bad-snowflake.json';
import proxyPath from './fixtures/error-proxy-unsupported-path.json';
import searchUnavailable from './fixtures/error-search-unavailable.json';
import userNotFound from './fixtures/error-user-not-found.json';

function response(status: number, body: unknown, headers: Record<string, string> = {}): UpstreamResponse {
  return { url: 'https://upstream.test/x', status, headers: new Headers(headers), body, snippet: '' };
}

function failure(route: RouteKind, res: UpstreamResponse, context = { postId: '20', handle: 'jack', q: 'from:jack' }) {
  try {
    classify(route, res, context);
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error('expected a ToolError');
}

describe('classify', () => {
  it('passes 2xx JSON with the expected key through', () => {
    expect(classify('status', response(200, { code: 200, status: { id: '20' } }), {})).toEqual({
      kind: 'ok',
      body: { code: 200, status: { id: '20' } }
    });
    expect(classify('statuses', response(200, { code: 200, results: [] }), {})).toMatchObject({ kind: 'ok' });
  });

  it.each([
    ['status', response(200, undefined)],
    ['status', response(200, { code: 200 })],
    ['statuses', response(200, { code: 200, results: 'nope' })],
    ['profile', response(200, 'text')],
    ['trends', response(200, { code: 200 })],
    ['typeahead', response(200, { code: 200 })]
  ] as const)('maps malformed 2xx bodies on %s to upstream_unavailable (U1)', (route, res) => {
    expect(failure(route, res)).toMatchObject({ code: 'upstream_unavailable', retryable: true });
  });

  it('maps redirects to upstream_unavailable (U2)', () => {
    expect(failure('status', response(302, undefined))).toMatchObject({ code: 'upstream_unavailable', retryable: false, upstreamStatus: 302 });
  });

  it('uses body.code as the effective status when HTTP is 200', () => {
    expect(failure('profile', response(200, { code: 404, message: 'User not found' }))).toMatchObject({ code: 'not_found' });
  });

  it('maps 400s (U3, U4, U5, U5b)', () => {
    expect(failure('status', response(400, badSnowflake))).toMatchObject({
      code: 'invalid_argument',
      message: "'20' is not a valid X post ID."
    });
    expect(failure('statuses', response(400, proxyPath))).toMatchObject({ code: 'internal' });
    expect(failure('search', response(400, { code: 400, message: 'bad query' }))).toMatchObject({ code: 'invalid_argument' });
    expect(failure('trends', response(400, { code: 400, message: 'bad count' }))).toMatchObject({ code: 'internal' });
  });

  it('maps 401/403 to restricted (U6, U7)', () => {
    expect(failure('status', response(401, { code: 401, message: 'Private or unavailable post' }))).toMatchObject({
      code: 'restricted',
      message: 'Post 20 is not publicly visible (protected account, or age-restricted or withheld content).'
    });
    expect(failure('statuses', response(403, {}))).toMatchObject({ code: 'restricted', message: "@jack's content is not publicly visible." });
  });

  it('maps 404s (U8, U9, U10) and treats list 404s as empty pages', () => {
    expect(failure('status', response(404, { code: 404 }))).toMatchObject({ code: 'not_found' });
    expect(failure('reposts', response(404, { code: 404 }))).toMatchObject({ code: 'not_found' });
    expect(failure('profile', response(404, { ...userNotFound, reason: 'suspended' }))).toMatchObject({
      code: 'restricted',
      message: '@jack is suspended on X.'
    });
    expect(failure('profile', response(404, userNotFound))).toMatchObject({
      code: 'not_found',
      message: "No public X account named 'jack' was found."
    });
    for (const route of ['statuses', 'media', 'articles', 'followers', 'following', 'search', 'typeahead', 'trends'] as const) {
      expect(classify(route, response(404, userNotFound), {})).toEqual({ kind: 'empty' });
    }
    expect(classify('statuses', response(204, undefined), {})).toEqual({ kind: 'empty' });
  });

  it('maps 429 with Retry-After (U14)', () => {
    expect(failure('status', response(429, {}, { 'Retry-After': '30' }))).toMatchObject({
      code: 'rate_limited',
      retryable: true,
      retryAfterSeconds: 30
    });
  });

  it('maps search unavailability to feature_unavailable with a concrete alternative (U15)', () => {
    expect(failure('search', response(503, searchUnavailable))).toMatchObject({
      code: 'feature_unavailable',
      retryable: false,
      hint: 'This query asks for posts from @jack: call get_profile_statuses with {"handle":"jack","count":10} and filter the results yourself.'
    });
    expect(failure('search', response(503, searchUnavailable), { postId: '', handle: '', q: 'open source' }).hint).toBe(
      'For posts by a known account call get_profile_statuses, e.g. {"handle":"nasa","count":10}; for a known post call get_post with its link as id.'
    );
    expect(failure('typeahead', response(503, searchUnavailable), { postId: '', handle: '', q: '@jack' })).toMatchObject({
      code: 'feature_unavailable',
      hint: 'If you know or can guess the handle, check it with get_profile, e.g. {"handle":"jack"}.'
    });
    expect(failure('status', response(200, searchUnavailable))).toMatchObject({ code: 'feature_unavailable' });
  });

  it('maps other statuses (U16, U17)', () => {
    expect(failure('status', response(502, {}))).toMatchObject({ code: 'upstream_unavailable', retryable: true, upstreamStatus: 502 });
    expect(failure('status', response(418, {}))).toMatchObject({ code: 'upstream_unavailable', retryable: false, upstreamStatus: 418 });
  });

  it('never leaks upstream bodies or URLs into messages', () => {
    const error = failure('statuses', response(400, proxyPath));
    expect(`${error.message} ${error.hint}`).not.toMatch(/allowedPrefix|api\/fx|upstream\.test/);
  });
});

describe('parseRetryAfter', () => {
  it('accepts delta-seconds and HTTP dates, clamped to 1..3600, default 60', () => {
    const now = Date.parse('2026-11-27T00:00:00Z');
    expect(parseRetryAfter('30', now)).toBe(30);
    expect(parseRetryAfter('0', now)).toBe(1);
    expect(parseRetryAfter('99999', now)).toBe(3600);
    expect(parseRetryAfter('Fri, 27 Nov 2026 00:02:00 GMT', now)).toBe(120);
    expect(parseRetryAfter(null, now)).toBe(60);
    expect(parseRetryAfter('soon', now)).toBe(60);
  });
});

describe('createSession', () => {
  const ok: UpstreamResponse = response(200, { code: 200, status: { id: '20' } });

  it('maps client failures to timeout and upstream_unavailable (U18, U19, U20)', async () => {
    for (const [kind, code] of [
      ['timeout', 'timeout'],
      ['network', 'upstream_unavailable'],
      ['too_large', 'upstream_unavailable']
    ] as const) {
      const client: UpstreamClient = { get: async () => Promise.reject(new UpstreamError(kind, 'x')) };
      const session = createSession(client, { log: () => {} });
      await expect(session.fetch(routes.status('20'), {})).rejects.toMatchObject({ code });
    }
  });

  it('caps upstream requests per tool call at 3', async () => {
    const client: UpstreamClient = { get: vi.fn(async () => ok) };
    const session = createSession(client, { log: () => {} });

    for (let i = 0; i < 3; i++) await session.fetch(routes.status('20'), {});
    await expect(session.fetch(routes.status('20'), {})).rejects.toMatchObject({ code: 'internal' });
    expect(client.get).toHaveBeenCalledTimes(3);
  });

  it('logs failures without queries, cursors or bodies beyond a short snippet', async () => {
    const lines: unknown[] = [];
    const client: UpstreamClient = {
      get: async () => ({ ...response(503, searchUnavailable), snippet: '{"code":503}' })
    };
    const session = createSession(client, { log: (line) => lines.push(line) });

    await expect(session.fetch(routes.search({ q: 'secret query', feed: 'latest', cursor: 'CURSOR' }), { q: 'secret query' })).rejects.toMatchObject({
      code: 'feature_unavailable'
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ evt: 'upstream_error', route: 'search', status: 503, code: 'feature_unavailable' });
    // Upstream bodies on query routes can echo the query, so they are never logged.
    expect(lines[0]).not.toHaveProperty('snippet');
    expect(JSON.stringify(lines)).not.toMatch(/secret query|CURSOR/);
  });

  it('logs a short snippet for failures on routes without free-text input', async () => {
    const lines: Record<string, unknown>[] = [];
    const client: UpstreamClient = { get: async () => ({ ...response(400, { code: 400, allowedPrefix: '/x' }), snippet: '{"code":400}' }) };
    await expect(createSession(client, { log: (line) => lines.push(line) }).fetch(routes.status('20'), { postId: '20' })).rejects.toMatchObject({
      code: 'internal'
    });
    expect(lines[0]).toMatchObject({ route: 'status', snippet: '{"code":400}' });
  });

  it('shares an optional upstream budget across every tool call of one HTTP request', async () => {
    const client: UpstreamClient = { get: vi.fn(async () => ok) };
    const shared = { limit: 4, remaining: 4 };
    const first = createSession(client, { log: () => {}, shared });
    const second = createSession(client, { log: () => {}, shared });

    for (let i = 0; i < 3; i++) await first.fetch(routes.status('20'), {});
    await second.fetch(routes.status('20'), {});
    await expect(second.fetch(routes.status('20'), {})).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
      message: 'This HTTP request already made 4 upstream requests, the most one request may make.'
    });
    expect(client.get).toHaveBeenCalledTimes(4);
  });
});
