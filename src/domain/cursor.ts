/**
 * Stateless pagination cursors: "xc1." + base64url(JSON [scope, up, off, anc]) + "." + fnv1a32 checksum.
 * - scope binds the cursor to the tool and its arguments
 * - up is the upstream cursor of the page being sliced (null = newest page)
 * - off is the raw index of the next unhandled entry on that page
 * - anc is the id of the last handled entry, used to resume correctly when the page shifts
 * The checksum only detects corruption (e.g. a model dropping characters); cursors are not a security boundary.
 */
import { corruptCursor, cursorScopeMismatch, cursorVersion } from '../contract/messages';
import { CURSOR_MAX_LEN, CURSOR_MAX_OFFSET } from '../contract/limits';

export type CursorState = { up: string | null; off: number; anc: string | null };

export type CursorScope =
  | { tool: 'get_profile_statuses'; handle: string; includeReplies: boolean }
  | {
      tool: 'get_profile_media' | 'get_profile_articles' | 'get_profile_followers' | 'get_profile_following';
      handle: string;
    }
  | { tool: 'get_post_reposts'; postId: string }
  | { tool: 'search_posts'; feed: string; q: string };

const PREFIX = 'xc1.';
const UPSTREAM_CURSOR_RE = /^[A-Za-z0-9+/=_|-]{1,512}$/;
const ANCHOR_RE = /^\d{1,20}$/;
const MAX_SCOPE_LENGTH = 80;
const START: CursorState = { up: null, off: 0, anc: null };

const HANDLE_SCOPES: Record<string, string> = {
  st: 'get_profile_statuses',
  md: 'get_profile_media',
  ar: 'get_profile_articles',
  fr: 'get_profile_followers',
  fg: 'get_profile_following'
};

export function scopeKey(scope: CursorScope): string {
  switch (scope.tool) {
    case 'get_profile_statuses':
      return `${scope.includeReplies ? 'st+r' : 'st'}:${scope.handle.toLowerCase()}`;
    case 'get_profile_media':
      return `md:${scope.handle.toLowerCase()}`;
    case 'get_profile_articles':
      return `ar:${scope.handle.toLowerCase()}`;
    case 'get_profile_followers':
      return `fr:${scope.handle.toLowerCase()}`;
    case 'get_profile_following':
      return `fg:${scope.handle.toLowerCase()}`;
    case 'get_post_reposts':
      return `rp:${scope.postId}`;
    case 'search_posts':
      return `sr:${scope.feed}:${fnv1a32(scope.q.trim())}`;
  }
}

/** Human-readable scope for error messages. Only well-formed scopes are rendered, so a forged cursor cannot inject text. */
export function describeScopeKey(key: string): string {
  const handleScope = /^(st\+r|st|md|ar|fr|fg):([a-z0-9_]{1,30})$/.exec(key);
  if (handleScope) {
    const [, kind = '', handle = ''] = handleScope;
    if (kind === 'st+r') return `get_profile_statuses with include_replies=true for @${handle}`;
    return `${HANDLE_SCOPES[kind] ?? 'a different tool'} for @${handle}`;
  }
  const repostScope = /^rp:(\d{2,20})$/.exec(key);
  if (repostScope) return `get_post_reposts for post ${repostScope[1]}`;
  if (/^sr:(latest|top):[0-9a-f]{8}$/.test(key)) return 'search_posts for a different query or feed';
  return 'a different call';
}

export function encodeCursor(scope: string, state: CursorState): string {
  const body = PREFIX + base64UrlEncode(JSON.stringify([scope, state.up, state.off, state.anc]));
  return `${body}.${fnv1a32(body)}`;
}

export function decodeCursor(input: string | undefined, expectedScope: string): CursorState {
  const value = (input ?? '').trim();
  if (value === '') return START;
  if (value.length > CURSOR_MAX_LEN) throw corruptCursor();

  if (value.startsWith(PREFIX)) {
    const parts = value.split('.');
    if (parts.length !== 3) throw corruptCursor();
    const [prefix = '', payload = '', checksum = ''] = parts;
    const body = `${prefix}.${payload}`;
    if (fnv1a32(body) !== checksum) throw corruptCursor();
    const decoded = parsePayload(payload);
    if (decoded.scope !== expectedScope) throw cursorScopeMismatch(describeScopeKey(decoded.scope));
    return decoded.state;
  }
  if (/^xc\d+\./.test(value)) throw cursorVersion();
  if (UPSTREAM_CURSOR_RE.test(value)) return { up: value, off: 0, anc: null };
  throw corruptCursor();
}

function parsePayload(payload: string): { scope: string; state: CursorState } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(payload));
  } catch {
    throw corruptCursor();
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) throw corruptCursor();
  const [scope, up, off, anc] = parsed as unknown[];
  const valid =
    typeof scope === 'string' &&
    scope.length <= MAX_SCOPE_LENGTH &&
    (up === null || (typeof up === 'string' && UPSTREAM_CURSOR_RE.test(up))) &&
    typeof off === 'number' &&
    Number.isInteger(off) &&
    off >= 0 &&
    off <= CURSOR_MAX_OFFSET &&
    (anc === null || (typeof anc === 'string' && ANCHOR_RE.test(anc)));
  if (!valid) throw corruptCursor();
  return { scope, state: { up, off, anc } };
}

/** FNV-1a 32-bit hash of the UTF-16 code units, as 8 lowercase hex characters. */
export function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function base64UrlEncode(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url alphabet');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}
