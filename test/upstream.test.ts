import { describe, expect, it, vi } from 'vitest';
import { createUpstreamClient, UpstreamError } from '../src/upstream/client';
import { routes } from '../src/upstream/routes';
import { VERSION } from '../src/version';

const BASE = 'https://upstream.test/api/fx';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
  });
}

describe('routes', () => {
  it('builds every upstream path with only the allowed query keys', () => {
    expect(routes.status('20')).toMatchObject({ kind: 'status', segments: ['2', 'status', '20'] });
    expect(routes.reposts('20', { cursor: 'c' }).params.toString()).toBe('cursor=c');
    expect(routes.profile('jack', { aboutAccount: true }).params.toString()).toBe('about_account=1');
    expect(routes.profile('jack', { aboutAccount: false }).params.toString()).toBe('');
    expect(routes.statuses('jack', { cursor: null, withReplies: true }).params.toString()).toBe('with_replies=1');
    expect(routes.statuses('jack', { cursor: 'c', withReplies: false }).segments).toEqual(['2', 'profile', 'jack', 'statuses']);
    expect(routes.media('jack', { cursor: null }).segments).toEqual(['2', 'profile', 'jack', 'media']);
    expect(routes.articles('jack', { cursor: null }).segments).toEqual(['2', 'profile', 'jack', 'articles']);
    expect(routes.followers('jack', { cursor: null }).segments).toEqual(['2', 'profile', 'jack', 'followers']);
    expect(routes.following('jack', { cursor: null }).segments).toEqual(['2', 'profile', 'jack', 'following']);
    expect(routes.trends({ count: 50 }).params.toString()).toBe('count=50');
    expect(routes.search({ q: 'from:jack', feed: 'top', cursor: null }).params.toString()).toBe('q=from%3Ajack&feed=top');
    expect(routes.typeahead({ q: 'jack' }).params.toString()).toBe('q=jack');
  });

  it('refuses identifiers that fail validation (defense in depth)', () => {
    expect(() => routes.status('../x')).toThrow();
    expect(() => routes.profile('a/b', { aboutAccount: false })).toThrow();
    expect(() => routes.statuses('..', { cursor: null, withReplies: false })).toThrow();
  });
});

describe('createUpstreamClient', () => {
  it('requests the encoded URL without following redirects', async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => jsonResponse({ code: 200 }));
    const client = createUpstreamClient({ baseUrl: `${BASE}/`, fetch });

    const result = await client.get(routes.statuses('jack', { cursor: 'x y', withReplies: false }));

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${BASE}/2/profile/jack/statuses?cursor=x+y`);
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('Accept')).toBe('application/json');
    expect(new Headers(init?.headers).get('User-Agent')).toBe(`x-mcp/${VERSION} (+https://x.mcp.2-38.com)`);
    expect(result).toMatchObject({ url, status: 200, body: { code: 200 } });
  });

  it('returns non-2xx responses for classification instead of throwing', async () => {
    const body = { code: 503, message: 'X/Twitter search is unavailable due to current API limitations.' };
    const client = createUpstreamClient({ baseUrl: BASE, fetch: async () => jsonResponse(body, 503, { 'Retry-After': '5' }) });

    const result = await client.get(routes.search({ q: 'from:jack', feed: 'latest', cursor: null }));

    expect(result).toMatchObject({ status: 503, body });
    expect(result.headers.get('Retry-After')).toBe('5');
  });

  it('parses JSON once and leaves invalid or non-JSON bodies undefined', async () => {
    const respond = (text: string, type: string) => async () => new Response(text, { headers: { 'Content-Type': type } });

    const broken = await createUpstreamClient({ baseUrl: BASE, fetch: respond('{not json', 'application/json') }).get(routes.trends({ count: 1 }));
    const plain = await createUpstreamClient({ baseUrl: BASE, fetch: respond('hello', 'text/plain') }).get(routes.trends({ count: 1 }));
    const empty = await createUpstreamClient({ baseUrl: BASE, fetch: async () => new Response(null, { status: 204 }) }).get(routes.trends({ count: 1 }));

    expect(broken).toMatchObject({ body: undefined, snippet: '{not json' });
    expect(plain).toMatchObject({ body: undefined, snippet: 'hello' });
    expect(empty).toMatchObject({ status: 204, body: undefined, snippet: '' });
  });

  it('times out when the headers never arrive', async () => {
    const fetch = (_input: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const client = createUpstreamClient({ baseUrl: BASE, fetch, timeoutMs: 5 });

    await expect(client.get(routes.status('20'))).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('times out when the body stalls after the headers arrived', async () => {
    const fetch = async (_input: string, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"code":'));
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        }
      });
      return new Response(stream, { headers: { 'Content-Type': 'application/json' } });
    };
    const client = createUpstreamClient({ baseUrl: BASE, fetch, timeoutMs: 20 });

    await expect(client.get(routes.status('20'))).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('refuses bodies over the size cap', async () => {
    const big = 'x'.repeat(2048);
    const client = createUpstreamClient({
      baseUrl: BASE,
      fetch: async () => new Response(big, { headers: { 'Content-Type': 'application/json' } }),
      maxBytes: 1024
    });

    const error = await client.get(routes.status('20')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ kind: 'too_large' });
  });

  it('reports network failures', async () => {
    const client = createUpstreamClient({
      baseUrl: BASE,
      fetch: async () => {
        throw new TypeError('fetch failed');
      }
    });

    await expect(client.get(routes.status('20'))).rejects.toMatchObject({ kind: 'network' });
  });
});
