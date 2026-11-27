import { describe, expect, it } from 'vitest';
import { DEFAULT_UPSTREAM_BASE_URL, readConfig } from '../src/config';

describe('readConfig', () => {
  it('normalizes the upstream base URL and drops empty query or fragment markers', () => {
    expect(readConfig({ UPSTREAM_BASE_URL: 'https://example.com/api/fx/' }).upstreamBaseUrl).toBe('https://example.com/api/fx');
    expect(readConfig({ UPSTREAM_BASE_URL: 'https://example.com/api?' }).upstreamBaseUrl).toBe('https://example.com/api');
    expect(readConfig({ UPSTREAM_BASE_URL: 'https://example.com/api#' }).upstreamBaseUrl).toBe('https://example.com/api');
  });

  it('falls back to the default for missing, non-https or query-carrying URLs', () => {
    expect(readConfig({}).upstreamBaseUrl).toBe(DEFAULT_UPSTREAM_BASE_URL);
    expect(readConfig({ UPSTREAM_BASE_URL: 'http://example.com/api' }).upstreamBaseUrl).toBe(DEFAULT_UPSTREAM_BASE_URL);
    expect(readConfig({ UPSTREAM_BASE_URL: 'https://example.com/api?x=1' }).upstreamBaseUrl).toBe(DEFAULT_UPSTREAM_BASE_URL);
  });

  it('enables search wording only for "true"', () => {
    expect(readConfig({ SEARCH_ENABLED: 'true' }).searchEnabled).toBe(true);
    expect(readConfig({ SEARCH_ENABLED: 'false' }).searchEnabled).toBe(false);
    expect(readConfig({}).searchEnabled).toBe(false);
  });
});
