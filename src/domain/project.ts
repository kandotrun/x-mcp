/**
 * Concise projections of upstream objects. Total functions: they never throw, guard every access,
 * keep a fixed key order and omit empty values (but keep 0 and meaningful false values).
 */
import type { About, Media, Post, PostItem, Quote, Trend, TypeaheadUser, Unavailable, User } from '../contract/envelopes';
import {
  ALT_MAX,
  ARTICLE_TEXT_MAX,
  LIST_TEXT_MAX,
  POST_TEXT_MAX,
  PREVIEW_MAX,
  QUOTE_TEXT_MAX_LIST,
  QUOTE_TEXT_MAX_POST
} from '../contract/limits';
import { cut } from './text';

type Rec = Record<string, unknown>;
type QuotedPost = Extract<Quote, { text: string }>;

/** 'list' items are capped harder than a single post. */
export type PostMode = 'list' | 'single';

const rec = (value: unknown): Rec | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : undefined;
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === '' || value === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function put<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined | false | null): void {
  if (!isEmpty(value)) target[key] = value as T[K];
}

/** ISO-8601 UTC without milliseconds from an upstream timestamp (seconds or ms) or date string. */
export function isoTime(timestamp: unknown, text: unknown): string | undefined {
  const ts = num(timestamp);
  if (ts !== undefined) return toIso(ts >= 1e12 ? ts : ts * 1000);
  const value = str(text);
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : toIso(ms);
}

function toIso(ms: number): string | undefined {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function unavailable(raw: Rec | undefined): Unavailable {
  const item: Unavailable = { unavailable: str(raw?.reason) ?? 'unavailable' };
  const id = str(raw?.id);
  const url = str(raw?.url);
  return { ...(id === undefined ? {} : { id }), ...(url === undefined ? {} : { url }), ...item };
}

function author(raw: unknown): Post['author'] {
  const user = rec(raw);
  const handle = str(user?.screen_name);
  if (handle === undefined) return undefined;
  const out: NonNullable<Post['author']> = { handle };
  put(out, 'name', str(user?.name));
  if (rec(user?.verification)?.verified === true) out.verified = true;
  return out;
}

function mediaItems(raw: unknown): Media[] {
  const media = rec(raw);
  if (media === undefined) return [];
  const all = Array.isArray(media.all) ? media.all : [...arr(media.photos), ...arr(media.videos)];
  const out: Media[] = [];
  for (const entry of all) {
    const item = rec(entry);
    const url = str(item?.url);
    if (item === undefined || url === undefined) continue;
    const declared = item.type;
    const type: Media['type'] =
      declared === 'photo' || declared === 'video' || declared === 'gif'
        ? declared
        : str(item.thumbnail_url) === undefined
          ? 'photo'
          : 'video';
    const projected: Media = { type, url };
    if (type === 'photo') {
      const alt = str(item.altText);
      put(projected, 'alt', alt === undefined ? undefined : cut(alt, ALT_MAX).text);
    } else {
      put(projected, 'thumbnail_url', str(item.thumbnail_url));
      const duration = num(item.duration);
      if (duration !== undefined) projected.duration_s = Math.round(duration * 10) / 10;
    }
    out.push(projected);
  }
  const external = str(rec(media.external)?.url);
  if (external !== undefined) out.push({ type: 'external', url: external });
  return out;
}

function quote(raw: unknown, max: number): Quote | undefined {
  const q = rec(raw);
  if (q === undefined) return undefined;
  if (q.type !== 'status') return unavailable(q);
  const id = str(q.id);
  if (id === undefined) return unavailable(q);
  const text = cut(str(q.text) ?? '', max);
  const head: Omit<QuotedPost, 'text' | 'text_truncated'> = { id };
  put(head, 'url', str(q.url));
  put(head, 'author', str(rec(q.author)?.screen_name));
  put(head, 'created_at', isoTime(q.created_timestamp, q.created_at));
  const out: QuotedPost = { ...head, text: text.text };
  if (text.truncated) out.text_truncated = true;
  return out;
}

const ARTICLE_PREFIX: Record<string, string> = {
  'header-one': '# ',
  'header-two': '## ',
  'header-three': '### ',
  'unordered-list-item': '- ',
  'ordered-list-item': '1. ',
  blockquote: '> '
};

/** Plain text of an X Article body (Draft.js blocks). Atomic and blank blocks are skipped; inline links are dropped. */
export function articleText(content: unknown): string {
  const blocks = arr(rec(content)?.blocks);
  const parts: string[] = [];
  for (const entry of blocks) {
    const block = rec(entry);
    const text = typeof block?.text === 'string' ? block.text : '';
    if (block === undefined || block.type === 'atomic' || text.trim() === '') continue;
    const prefix = typeof block.type === 'string' && Object.hasOwn(ARTICLE_PREFIX, block.type) ? ARTICLE_PREFIX[block.type] : '';
    parts.push(`${prefix}${text}`);
  }
  return parts.join('\n\n');
}

/** Caps for `single` mode; callers lower them only to keep one huge post under the result budget. */
export type SingleLimits = { textMax?: number; articleMax?: number };

export function projectPost(raw: unknown, mode: PostMode, limits: SingleLimits = {}): PostItem {
  const p = rec(raw);
  if (p === undefined || (p.type !== undefined && p.type !== 'status')) return unavailable(p);
  const id = str(p.id);
  if (id === undefined) return unavailable(p);

  const head: Omit<Post, 'text'> = { id };
  put(head, 'url', str(p.url));
  put(head, 'created_at', isoTime(p.created_timestamp, p.created_at));
  put(head, 'author', author(p.author));
  put(head, 'reposted_by', str(rec(p.reposted_by)?.screen_name));
  const replyingTo = rec(p.replying_to);
  const replyHandle = str(replyingTo?.screen_name);
  if (replyHandle !== undefined) {
    const postId = str(replyingTo?.status);
    head.reply_to = postId === undefined ? { handle: replyHandle } : { handle: replyHandle, post_id: postId };
  }
  const text = cut(str(p.text) ?? '', mode === 'list' ? LIST_TEXT_MAX : (limits.textMax ?? POST_TEXT_MAX));
  // Spreading keeps the documented key order: identity fields, then text.
  const out: Post = { ...head, text: text.text };
  if (text.truncated) out.text_truncated = true;
  put(out, 'lang', str(p.lang));

  const metrics: NonNullable<Post['metrics']> = {};
  for (const key of ['replies', 'reposts', 'quotes', 'likes', 'bookmarks', 'views'] as const) {
    const value = num(p[key]);
    if (value !== undefined) metrics[key] = value;
  }
  put(out, 'metrics', metrics);
  put(out, 'quote', quote(p.quote, mode === 'list' ? QUOTE_TEXT_MAX_LIST : QUOTE_TEXT_MAX_POST));
  put(out, 'media', mediaItems(p.media));

  const card = rec(p.card);
  const cardUrl = str(card?.url);
  if (cardUrl !== undefined) {
    const projected: NonNullable<Post['card']> = { url: cardUrl };
    put(projected, 'title', str(card?.title));
    out.card = projected;
  }

  const poll = rec(p.poll);
  if (poll !== undefined && Array.isArray(poll.choices)) {
    const choices = poll.choices.flatMap((entry) => {
      const choice = rec(entry);
      const label = str(choice?.label);
      if (label === undefined) return [];
      const projected: { label: string; votes?: number; percent?: number } = { label };
      const votes = num(choice?.count);
      const percent = num(choice?.percentage);
      if (votes !== undefined) projected.votes = votes;
      if (percent !== undefined) projected.percent = percent;
      return [projected];
    });
    const projected: NonNullable<Post['poll']> = { choices };
    const total = num(poll.total_votes);
    if (total !== undefined) projected.total_votes = total;
    put(projected, 'ends_at', str(poll.ends_at));
    out.poll = projected;
  }

  const article = rec(p.article);
  if (article !== undefined) {
    const projected: NonNullable<Post['article']> = {};
    put(projected, 'title', str(article.title));
    const preview = str(article.preview_text);
    put(projected, 'preview_text', preview === undefined ? undefined : cut(preview, PREVIEW_MAX).text);
    if (mode === 'single') {
      const body = cut(articleText(article.content), limits.articleMax ?? ARTICLE_TEXT_MAX);
      put(projected, 'text', body.text);
      if (body.truncated) projected.text_truncated = true;
    }
    put(out, 'article', projected);
  }

  put(out, 'community_note', typeof p.community_note === 'string' ? str(p.community_note) : str(rec(p.community_note)?.text));
  if (p.possibly_sensitive === true) out.possibly_sensitive = true;
  return out;
}

export function projectUser(raw: unknown, options: { includeAbout?: boolean } = {}): User {
  const u = rec(raw);
  const out: User = { handle: str(u?.screen_name) ?? '' };
  put(out, 'name', str(u?.name));
  put(out, 'id', str(u?.id));
  put(out, 'url', str(u?.url));
  put(out, 'description', str(u?.description));
  put(out, 'location', str(u?.location));
  put(out, 'website', str(rec(u?.website)?.url));
  put(out, 'joined', isoTime(undefined, u?.joined));
  for (const [key, source] of [
    ['followers', 'followers'],
    ['following', 'following'],
    ['posts', 'statuses'],
    ['likes', 'likes'],
    ['media_count', 'media_count']
  ] as const) {
    const value = num(u?.[source]);
    if (value !== undefined) out[key] = value;
  }
  const verification = rec(u?.verification);
  if (verification?.verified === true) {
    out.verified = true;
    put(out, 'verified_type', str(verification.type));
  }
  if (u?.protected === true) out.protected = true;
  if (options.includeAbout) put(out, 'about', about(u?.about_account));
  return out;
}

function about(raw: unknown): About | undefined {
  const a = rec(raw);
  if (a === undefined) return undefined;
  const out: About = {};
  put(out, 'based_in', str(a.based_in));
  if (typeof a.location_accurate === 'boolean') out.location_accurate = a.location_accurate;
  if (typeof a.created_country_accurate === 'boolean') out.created_country_accurate = a.created_country_accurate;
  put(out, 'source', str(a.source));
  const changes = rec(a.username_changes);
  const count = num(changes?.count);
  if (count !== undefined) out.username_changes = count;
  put(out, 'username_last_changed_at', isoTime(undefined, changes?.last_changed_at));
  return out;
}

export function projectTypeaheadUser(raw: unknown): TypeaheadUser {
  const u = rec(raw);
  const out: TypeaheadUser = { handle: str(u?.screen_name) ?? '' };
  put(out, 'name', str(u?.name));
  if (rec(u?.verification)?.verified === true) out.verified = true;
  const followers = num(u?.followers);
  if (followers !== undefined) out.followers = followers;
  return out;
}

export function projectTrend(raw: unknown): Trend {
  const t = rec(raw);
  const out: Trend = { name: str(t?.name) ?? '' };
  put(out, 'context', str(t?.context));
  const rank = typeof t?.rank === 'number' ? t.rank : typeof t?.rank === 'string' && /^\d+$/.test(t.rank) ? Number(t.rank) : undefined;
  if (rank !== undefined && Number.isFinite(rank)) out.rank = rank;
  return out;
}

/** A post whose concise form still does not fit in a result: just enough to identify and open it. */
export function tooLargePost(raw: unknown): Unavailable {
  const p = rec(raw);
  const id = str(p?.id);
  const url = str(p?.url);
  return { ...(id === undefined ? {} : { id }), ...(url === undefined || url.length > 512 ? {} : { url }), unavailable: 'too_large' };
}

/** Detailed mode: the upstream object unchanged except that every `mosaic` key (a rendered collage) is removed. */
export function stripMosaic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMosaic);
  const object = rec(value);
  if (object === undefined) return value;
  const out: Rec = {};
  for (const [key, entry] of Object.entries(object)) {
    if (key !== 'mosaic') out[key] = stripMosaic(entry);
  }
  return out;
}
