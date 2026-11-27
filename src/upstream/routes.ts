/**
 * The only place that builds upstream paths. Identifiers are re-validated here (defense in depth on top of
 * input normalization) and each route sets only its allowed query keys.
 */
import { HANDLE_RE, POST_ID_RE } from '../domain/normalize';

export type RouteKind =
  | 'status'
  | 'reposts'
  | 'profile'
  | 'statuses'
  | 'media'
  | 'articles'
  | 'followers'
  | 'following'
  | 'trends'
  | 'search'
  | 'typeahead';

export type Route = { kind: RouteKind; segments: readonly string[]; params: URLSearchParams };

type Cursor = { cursor: string | null };

function postId(value: string): string {
  if (!POST_ID_RE.test(value)) throw new Error('invalid post id for an upstream route');
  return value;
}

function handle(value: string): string {
  if (!HANDLE_RE.test(value)) throw new Error('invalid handle for an upstream route');
  return value;
}

function params(entries: Record<string, string | null | undefined>): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, value);
  }
  return search;
}

export const routes = {
  status: (id: string): Route => ({ kind: 'status', segments: ['2', 'status', postId(id)], params: params({}) }),

  reposts: (id: string, { cursor }: Cursor): Route => ({
    kind: 'reposts',
    segments: ['2', 'status', postId(id), 'reposts'],
    params: params({ cursor })
  }),

  profile: (name: string, { aboutAccount }: { aboutAccount: boolean }): Route => ({
    kind: 'profile',
    segments: ['2', 'profile', handle(name)],
    params: params({ about_account: aboutAccount ? '1' : null })
  }),

  statuses: (name: string, { cursor, withReplies }: Cursor & { withReplies: boolean }): Route => ({
    kind: 'statuses',
    segments: ['2', 'profile', handle(name), 'statuses'],
    params: params({ cursor, with_replies: withReplies ? '1' : null })
  }),

  media: (name: string, { cursor }: Cursor): Route => ({
    kind: 'media',
    segments: ['2', 'profile', handle(name), 'media'],
    params: params({ cursor })
  }),

  articles: (name: string, { cursor }: Cursor): Route => ({
    kind: 'articles',
    segments: ['2', 'profile', handle(name), 'articles'],
    params: params({ cursor })
  }),

  followers: (name: string, { cursor }: Cursor): Route => ({
    kind: 'followers',
    segments: ['2', 'profile', handle(name), 'followers'],
    params: params({ cursor })
  }),

  following: (name: string, { cursor }: Cursor): Route => ({
    kind: 'following',
    segments: ['2', 'profile', handle(name), 'following'],
    params: params({ cursor })
  }),

  trends: ({ count }: { count: number }): Route => ({
    kind: 'trends',
    segments: ['2', 'trends'],
    params: params({ count: String(count) })
  }),

  search: ({ q, feed, cursor }: Cursor & { q: string; feed: string }): Route => ({
    kind: 'search',
    segments: ['2', 'search'],
    params: params({ q, feed, cursor })
  }),

  typeahead: ({ q }: { q: string }): Route => ({ kind: 'typeahead', segments: ['2', 'typeahead'], params: params({ q }) })
} as const;
