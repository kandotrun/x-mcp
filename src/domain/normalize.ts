/**
 * Turn caller input into upstream identifiers. Pure functions; URLs are parsed, never fetched.
 * Post IDs: bare digits or any http(s) URL with the X status layout (mirrors and embeds included).
 * Handles: bare names, or x.com / twitter.com URLs (a post URL yields its author segment).
 */
import {
  articleLinkAsPost,
  invalidHandle,
  invalidPostRef,
  nonXHost,
  numericAccountId,
  postLinkWithoutAccount,
  profileLinkAsPost,
  shortLink
} from '../contract/messages';
import { cleanText } from './text';

/** The 0.1 range; the upstream validates the snowflake itself (it rejects "1" with a 400). */
export const POST_ID_RE = /^\d{1,30}$/;
export const HANDLE_RE = /^[A-Za-z0-9_]{1,30}$/;
const X_HOST_RE = /^(?:[a-z0-9-]+\.)*(?:x|twitter)\.com$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const STATUS_AUTHOR_SEGMENT_RE = /^@?[a-z0-9_]{1,50}$/i;

const RESERVED_SEGMENTS = new Set([
  'i',
  'home',
  'explore',
  'search',
  'settings',
  'notifications',
  'messages',
  'hashtag',
  'intent',
  'share',
  'compose',
  'login',
  'logout',
  'signup',
  'tos',
  'privacy',
  'account',
  'download',
  'jobs',
  'about',
  'help',
  'lists',
  'communities',
  'premium',
  'verified',
  'grok',
  'spaces',
  'status',
  'statuses'
]);

export function parsePostRef(input: string): string {
  const value = cleanText(input);
  if (value === '') throw invalidPostRef(input);
  if (/^\d+$/.test(value)) {
    if (POST_ID_RE.test(value)) return value;
    throw invalidPostRef(input);
  }

  const url = toHttpUrl(value);
  if (url === undefined) throw invalidPostRef(input);
  const host = hostOf(url);
  if (host === 't.co') throw shortLink();
  const segments = pathSegments(url);
  if (segments === undefined) throw invalidPostRef(input);

  const id = statusIdFrom(segments);
  if (id !== undefined) {
    if (POST_ID_RE.test(id)) return id;
    throw invalidPostRef(input);
  }
  if (lower(segments[0]) === 'i' && lower(segments[1]) === 'article') throw articleLinkAsPost(input);
  if (X_HOST_RE.test(host)) {
    const handle = profileSegment(segments);
    if (handle !== undefined) throw profileLinkAsPost(input, handle);
  }
  throw invalidPostRef(input);
}

export function parseHandleRef(input: string): string {
  const value = cleanText(input).replace(/^@+/, '');
  if (/^\d{16,}$/.test(value)) throw numericAccountId(input, POST_ID_RE.test(value) ? value : undefined);
  if (/^id:/i.test(value)) throw numericAccountId(input);
  if (HANDLE_RE.test(value)) return value;

  if (/[/.:]/.test(value)) {
    const url = toHttpUrl(value);
    if (url !== undefined) {
      const host = hostOf(url);
      if (!X_HOST_RE.test(host)) throw nonXHost(host);
      const segments = pathSegments(url) ?? [];
      if (lower(segments[0]) === 'i' && (isStatusKeyword(segments[1]) || lower(segments[1]) === 'web')) {
        throw postLinkWithoutAccount();
      }
      const handle = profileSegment(segments);
      if (handle !== undefined) return handle;
    }
  }
  throw invalidHandle(input);
}

function toHttpUrl(value: string): URL | undefined {
  let candidate = value;
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;
  else if (!SCHEME_RE.test(candidate)) candidate = `https://${candidate}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
}

function hostOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, '');
}

function pathSegments(url: URL): string[] | undefined {
  const segments: string[] = [];
  for (const raw of url.pathname.split('/')) {
    if (raw === '') continue;
    try {
      segments.push(decodeURIComponent(raw));
    } catch {
      return undefined;
    }
  }
  return segments;
}

/** The id position of an X status path, or undefined when the path is not a status path. '' means the id is missing. */
function statusIdFrom(segments: readonly string[]): string | undefined {
  const [first, second, third, fourth] = segments;
  if (lower(first) === 'i' && lower(second) === 'web' && isStatusKeyword(third)) return fourth ?? '';
  if (lower(first) === 'i' && isStatusKeyword(second)) return third ?? '';
  if (first !== undefined && STATUS_AUTHOR_SEGMENT_RE.test(first) && isStatusKeyword(second)) return third ?? '';
  return undefined;
}

function profileSegment(segments: readonly string[]): string | undefined {
  const first = segments[0]?.replace(/^@/, '');
  if (first === undefined || !HANDLE_RE.test(first) || RESERVED_SEGMENTS.has(first.toLowerCase())) return undefined;
  return first;
}

function isStatusKeyword(segment: string | undefined): boolean {
  const value = lower(segment);
  return value === 'status' || value === 'statuses';
}

function lower(segment: string | undefined): string | undefined {
  return segment?.toLowerCase();
}
