/** Worker configuration from env vars, validated once per request. */

export const DEFAULT_UPSTREAM_BASE_URL = 'https://twitter.2-38.com/api/fx';

export type Config = {
  upstreamBaseUrl: string;
  /** Only changes tool wording; handlers always call upstream. */
  searchEnabled: boolean;
};

/** wrangler types emits literal var types, so values are widened to string here. */
export type ConfigEnv = { UPSTREAM_BASE_URL?: string; SEARCH_ENABLED?: string };

export function readConfig(env: ConfigEnv | undefined, log: (line: Record<string, unknown>) => void = () => {}): Config {
  const raw: string = env?.UPSTREAM_BASE_URL ?? '';
  const flag: string = env?.SEARCH_ENABLED ?? '';
  return { upstreamBaseUrl: validBaseUrl(raw, log), searchEnabled: flag.trim().toLowerCase() === 'true' };
}

function validBaseUrl(raw: string, log: (line: Record<string, unknown>) => void): string {
  if (raw.trim() === '') return DEFAULT_UPSTREAM_BASE_URL;
  try {
    const url = new URL(raw.trim());
    if (url.protocol === 'https:' && url.search === '' && url.hash === '' && url.username === '' && url.password === '') {
      // origin + pathname also drops empty "?" or "#" markers that href keeps.
      return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    }
  } catch {
    // fall through to the default
  }
  log({ evt: 'config_error', key: 'UPSTREAM_BASE_URL', fallback: DEFAULT_UPSTREAM_BASE_URL });
  return DEFAULT_UPSTREAM_BASE_URL;
}
