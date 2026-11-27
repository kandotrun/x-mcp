/** HTTP client for the read-only upstream proxy (twitter.2-38.com/api/fx). The only module that performs I/O. */
import { UPSTREAM_MAX_BYTES, UPSTREAM_TIMEOUT_MS } from '../contract/limits';
import { VERSION } from '../version';
import type { Route } from './routes';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type UpstreamResponse = {
  url: string;
  status: number;
  headers: Headers;
  /** Parsed JSON, or undefined for empty, non-JSON or invalid JSON bodies. */
  body: unknown;
  /** At most the first 200 characters of the raw body, for server-side logs only. */
  snippet: string;
};

export type UpstreamFailureKind = 'timeout' | 'network' | 'too_large';

export class UpstreamError extends Error {
  readonly kind: UpstreamFailureKind;

  constructor(kind: UpstreamFailureKind, message: string) {
    super(message);
    this.name = 'UpstreamError';
    this.kind = kind;
  }
}

export type UpstreamClientOptions = {
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
};

export type UpstreamClient = {
  /** GET the route. Resolves for every HTTP status; rejects only with UpstreamError (timeout, network, too large). */
  get(route: Route): Promise<UpstreamResponse>;
};

const SNIPPET_LENGTH = 200;

export function createUpstreamClient(options: UpstreamClientOptions): UpstreamClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? UPSTREAM_MAX_BYTES;

  return {
    async get(route) {
      const query = route.params.toString();
      const url = `${baseUrl}/${route.segments.map((segment) => encodeURIComponent(segment)).join('/')}${query ? `?${query}` : ''}`;
      // Guard against dot-segment or percent normalization changing the path we validated.
      if (new URL(url).href !== url) throw new Error('upstream URL changed during normalization');

      const controller = new AbortController();
      // One timer covers the headers and the whole body read.
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'application/json', 'User-Agent': `x-mcp/${VERSION} (+https://x.mcp.2-38.com)` },
          redirect: 'manual',
          signal: controller.signal,
          cf: { cacheTtl: 0 }
        });
        const text = await readText(response, maxBytes);
        return {
          url,
          status: response.status,
          headers: response.headers,
          body: parseJson(text),
          snippet: text.slice(0, SNIPPET_LENGTH)
        };
      } catch (error) {
        if (error instanceof UpstreamError) throw error;
        if (controller.signal.aborted) {
          throw new UpstreamError('timeout', `Upstream did not respond within ${timeoutMs} ms`);
        }
        throw new UpstreamError('network', `Upstream request failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

/** Read the body exactly once, as text, refusing anything over `maxBytes`. */
async function readText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return '';
  const declared = Number(response.headers.get('Content-Length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel();
    throw new UpstreamError('too_large', `Upstream body declared ${declared} bytes`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new UpstreamError('too_large', `Upstream body exceeded ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseJson(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
