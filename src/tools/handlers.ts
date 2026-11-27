/**
 * Thin tool handlers: normalize input -> fetch -> classify -> paginate/project -> envelope.
 * They return the success envelope or throw ToolError; serialization happens in server.ts.
 */
import type { Config } from '../config';
import type { PostItem, User } from '../contract/envelopes';
import { ToolError } from '../contract/errors';
import { ARTICLE_TEXT_MAX, CURSOR_MAX_RETURNED, MAX_RESULT_CHARS, POST_TEXT_MAX, TRENDS_UPSTREAM_MAX } from '../contract/limits';
import {
  accountProtected,
  emptyQuery,
  notes,
  pageMissing,
  postNotFound,
  postRestricted,
  timelineMissing,
  unexpectedResponse
} from '../contract/messages';
import type { ResponseFormat, ToolArgs } from '../contract/tools';
import { decodeCursor, encodeCursor, isUpstreamCursor, MAX_UPSTREAM_CURSOR, scopeKey, type CursorState } from '../domain/cursor';
import { KEY_LENGTH, STOP_KEYS } from '../domain/paginate';
import { parseHandleRef, parsePostRef } from '../domain/normalize';
import { paginate, type Page, type PaginateResult } from '../domain/paginate';
import { projectPost, projectTrend, projectTypeaheadUser, projectUser, stripMosaic, tooLargePost, type SingleLimits } from '../domain/project';
import { routes, type Route } from '../upstream/routes';
import type { UpstreamSession } from '../upstream/session';
import type { ClassifyContext } from '../domain/classify';

export type ToolContext = { session: UpstreamSession; config: Config };

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : undefined;
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

const RESTRICTED_REASONS = new Set(['suspended', 'protected', 'private', 'blocked', 'withheld']);
const isRestricted = (reason: unknown) => typeof reason === 'string' && RESTRICTED_REASONS.has(reason);
/** Caps used when one post's text and Article body together would exceed the result budget. */
const OVERSIZED_SINGLE_LIMITS = { textMax: 6_000, articleMax: 6_000 };

const fits = (value: unknown, limit: number) => JSON.stringify(value).length <= limit;

// ---------------------------------------------------------------------------------------------
// Single objects

export async function getPost(args: ToolArgs<'get_post'>, { session }: ToolContext) {
  const postId = parsePostRef(args.id);
  const outcome = await session.fetch(routes.status(postId), { postId });
  const status = outcome.kind === 'ok' ? rec(outcome.body.status) : undefined;
  if (status === undefined) throw unexpectedResponse();
  if (status.type !== undefined && status.type !== 'status') {
    throw isRestricted(status.reason) ? postRestricted(postId) : postNotFound(postId);
  }
  if (args.response_format === 'detailed') {
    const detailed = { post: stripMosaic(status) };
    if (fits(detailed, MAX_RESULT_CHARS)) return detailed;
    return { post: conciseSinglePost(status, singlePostBudget(notes.detailedTooLarge)), note: notes.detailedTooLarge };
  }
  return { post: conciseSinglePost(status, singlePostBudget()) };
}

/** Characters left for the post in a {post, note?} result. */
const singlePostBudget = (note?: string) => MAX_RESULT_CHARS - JSON.stringify(note === undefined ? { post: 0 } : { post: 0, note }).length + 1;

/** The whole post when it fits in one result; otherwise its text or Article body is cut only as far as needed. */
function conciseSinglePost(raw: Rec, budget: number): PostItem {
  const limits: Required<SingleLimits> = { textMax: POST_TEXT_MAX, articleMax: ARTICLE_TEXT_MAX };
  for (let attempt = 0; attempt < 4; attempt++) {
    const post = projectPost(raw, 'single', limits);
    const overflow = JSON.stringify(post).length - budget;
    if (overflow <= 0) return post;
    const text = 'text' in post ? [...post.text].length : 0;
    const article = 'article' in post && post.article?.text !== undefined ? [...post.article.text].length : 0;
    // Each character removed saves at least one in JSON; the margin covers the ellipsis and the *_truncated flag.
    if (article > text) limits.articleMax = Math.max(0, Math.min(limits.articleMax, article) - overflow - 32);
    else limits.textMax = Math.max(0, Math.min(limits.textMax, text) - overflow - 32);
  }
  return projectPost(raw, 'single', OVERSIZED_SINGLE_LIMITS);
}

export async function getProfile(args: ToolArgs<'get_profile'>, { session }: ToolContext) {
  const handle = parseHandleRef(args.handle);
  const route = routes.profile(handle, { aboutAccount: args.include_about });
  let outcome;
  try {
    outcome = await session.fetch(route, { handle });
  } catch (error) {
    // The upstream occasionally answers "User not found" for accounts that exist, so ask once more.
    if (!(error instanceof ToolError) || error.code !== 'not_found') throw error;
    outcome = await session.fetch(route, { handle });
  }
  const user = outcome.kind === 'ok' ? rec(outcome.body.user) : undefined;
  if (user === undefined) throw unexpectedResponse();
  const protectedNote = user.protected === true ? notes.protectedProfile : undefined;
  const concise = () => projectUser(user, { includeAbout: args.include_about });
  if (args.response_format === 'detailed') {
    const detailed = withNote({ user: stripMosaic(user) }, protectedNote);
    if (fits(detailed, MAX_RESULT_CHARS)) return detailed;
    return withNote({ user: concise() }, joinNotes(protectedNote, notes.detailedTooLarge));
  }
  return withNote({ user: concise() }, protectedNote);
}

const joinNotes = (...parts: (string | undefined)[]) => parts.filter((part) => part !== undefined).join(' ');
const withNote = (result: Rec, note: string | undefined): Rec => (note === undefined || note === '' ? result : { ...result, note });

// ---------------------------------------------------------------------------------------------
// Lists

type ListKind = { key: 'posts' | 'users'; plural: string };
const POSTS: ListKind = { key: 'posts', plural: 'posts' };
const USERS: ListKind = { key: 'users', plural: 'accounts' };

type EmptyFirstPage = (
  retry: () => Promise<PaginateResult<unknown>>,
  first: PaginateResult<unknown>
) => Promise<PaginateResult<unknown> | { note: string }>;
/** Runs when the newest page fails with HTTP 500; throws a more specific error when it can find one. */
type FirstPageServerError = () => Promise<void>;

type ListRequest = {
  session: UpstreamSession;
  kind: ListKind;
  scope: string;
  cursor: string | undefined;
  count: number;
  format: ResponseFormat;
  route: (up: string | null) => Route;
  context: ClassifyContext;
  project: (raw: unknown) => unknown;
  /** A small stand-in for an item whose concise form alone exceeds the budget (posts only). */
  tooLarge?: (raw: unknown) => unknown;
  onEmptyFirstPage: EmptyFirstPage;
  onFirstPageServerError?: FirstPageServerError;
};

/** Keys, counts and the longest combination of notes in a list envelope. */
const ENVELOPE_OVERHEAD = 600;

/**
 * Characters left for list items once the envelope is accounted for: the longest next_cursor this call can issue
 * (continuing on the same upstream page, or after hopping to a new page with the longest issued bottom cursor) plus notes.
 */
export function itemBudgetFor(scope: string, state: CursorState, count: number): number {
  const seam = 'z'.repeat(KEY_LENGTH);
  const keys = 'z'.repeat(KEY_LENGTH * Math.min(CURSOR_MAX_RETURNED, state.returned.length / KEY_LENGTH + count));
  const samePage = encodeCursor(scope, { up: state.up, seam, returned: keys, stop: seam.repeat(STOP_KEYS) }).length;
  // After a hop the cursor can carry the longest issued bottom cursor and this call's keys.
  const hopped = encodeCursor(scope, { up: 'x'.repeat(MAX_UPSTREAM_CURSOR), seam, returned: keys }).length;
  return MAX_RESULT_CHARS - ENVELOPE_OVERHEAD - Math.max(samePage, hopped);
}

async function listPage(request: ListRequest): Promise<Rec> {
  const { session, kind, scope, count, format } = request;
  const state = decodeCursor(request.cursor, scope);
  const budget = itemBudgetFor(scope, state, count);
  // Items that were too large for detailed form and came back concise, or too large even for that.
  const fallbacks = new WeakSet<object>();
  const stubs = new WeakSet<object>();
  const concise = (raw: unknown) => {
    const projected = request.project(raw);
    if (request.tooLarge === undefined || fits(projected, budget)) return projected;
    const stub = request.tooLarge(raw);
    if (typeof stub === 'object' && stub !== null) stubs.add(stub);
    return stub;
  };
  const project = (raw: unknown) => {
    if (format === 'concise') return concise(raw);
    const detailed = stripMosaic(raw);
    if (fits(detailed, budget)) return detailed;
    const fallback = concise(raw);
    if (typeof fallback === 'object' && fallback !== null && !stubs.has(fallback)) fallbacks.add(fallback);
    return fallback;
  };
  let serverErrorChecked = false;
  let fetches = 0;
  // The last page fetched offered a next page, but with a cursor this server cannot carry in next_cursor.
  let bottomDropped = false;
  const fetchPage = async (up: string | null): Promise<Page> => {
    const firstFetch = fetches++ === 0;
    let outcome;
    try {
      outcome = await session.fetch(request.route(up), request.context);
    } catch (error) {
      // Only on a call's first request, so the lookup (up to 2 requests) stays within the 3-request cap.
      const check = firstFetch && up === null && !serverErrorChecked && request.onFirstPageServerError;
      if (check && error instanceof ToolError && error.upstreamStatus === 500) {
        serverErrorChecked = true;
        await check();
      }
      throw error;
    }
    bottomDropped = false;
    if (outcome.kind === 'empty') return { items: [], bottom: null, missing: true };
    const items = arr(outcome.body.results);
    const bottom = rec(outcome.body.cursor)?.bottom;
    if (isUpstreamCursor(bottom)) return { items, bottom };
    bottomDropped = items.length > 0 && typeof bottom === 'string' && bottom !== '';
    return { items, bottom: null };
  };
  const run = () => paginate({ state, count, fetchPage, project, budget });

  let result = await run();
  if (result.firstPageEmpty) {
    serverErrorChecked = true;
    const diagnosed = await request.onEmptyFirstPage(run, result);
    if ('note' in diagnosed) return { [kind.key]: [], returned: 0, has_more: false, note: diagnosed.note };
    result = diagnosed;
  }
  const returnedAny = (set: WeakSet<object>) => result.items.some((item) => typeof item === 'object' && item !== null && set.has(item));
  return listEnvelope(kind, scope, count, result, {
    detailedFellBack: returnedAny(fallbacks),
    tooLarge: returnedAny(stubs),
    cutShort: !result.hasMore && bottomDropped
  });
}

function listEnvelope(
  kind: ListKind,
  scope: string,
  count: number,
  result: PaginateResult<unknown>,
  flags: { detailedFellBack: boolean; tooLarge: boolean; cutShort: boolean }
): Rec {
  const returned = result.items.length;
  const envelope: Rec = { [kind.key]: result.items, returned, has_more: result.hasMore };
  if (result.hasMore && result.next !== undefined) envelope.next_cursor = encodeCursor(scope, result.next);
  if (result.truncated) envelope.truncated = true;
  const parts: string[] = [];
  if (result.truncated) parts.push(notes.budget(returned, kind.plural));
  else if (result.pageEnded) parts.push(notes.pageEnded(returned, count));
  if (flags.cutShort) parts.push(notes.cutShort(kind.plural));
  else if (result.endOfList && returned === 0) parts.push(notes.noMore(kind.plural));
  if (flags.detailedFellBack) parts.push(notes.detailedItemsTooLarge(kind.plural));
  if (flags.tooLarge) parts.push(notes.itemsTooLarge(kind.plural));
  if (parts.length > 0) envelope.note = parts.join(' ');
  return envelope;
}

/**
 * U11: an empty first page tells nothing on its own. An empty list (HTTP 200) shows that the account exists and that
 * the upstream has nothing to list; a "not found" is an unknown or suspended account, or a transient failure (the
 * upstream answers about one request in four that way). A profile lookup tells these apart, protected accounts
 * included, and one retry covers the transient case. Every path stays within 3 upstream requests.
 */
function diagnoseAccount(
  session: UpstreamSession,
  handle: string,
  options: {
    emptyNote: string;
    counter?: 'statuses' | 'media_count' | 'followers' | 'following';
    what: string;
    /** When the counter also counts items this listing excludes, an empty listing is valid and gets this note. */
    listedButEmptyNote?: (listed: number) => string;
  }
): EmptyFirstPage {
  const count = (user: Rec) => (options.counter === undefined ? undefined : num(user[options.counter]));
  // Why a list that came back empty (or "not found", when missing is true) is empty.
  const explain = (listed: number | undefined, missing: boolean) => {
    if (listed === 0 || (listed === undefined && !missing)) return { note: options.emptyNote };
    // Only an empty list shows that the listing excludes everything the counter counts.
    if (listed !== undefined && !missing && options.listedButEmptyNote !== undefined) return { note: options.listedButEmptyNote(listed) };
    throw timelineMissing(handle, options.what, listed);
  };
  return async (retry, first) => {
    if (!first.firstPageMissing) {
      // The account exists. The profile still reports protected accounts and gives the count; without a count, the
      // empty list already answers the question, so a "not found" profile does not matter.
      let user: Rec;
      try {
        user = await lookUpAccount(session, handle, options.counter !== undefined);
      } catch (error) {
        if (options.counter === undefined && error instanceof ToolError && error.code === 'not_found') return { note: options.emptyNote };
        throw error;
      }
      return explain(count(user), false);
    }
    let user: Rec;
    try {
      user = await lookUpAccount(session, handle);
    } catch (error) {
      // The profile answers "not found" transiently too; one more look at the list tells a flake from a missing account.
      if (!(error instanceof ToolError) || error.code !== 'not_found') throw error;
      const retried = await retry();
      if (retried.items.length > 0 || retried.hasMore) return retried;
      if (options.counter === undefined && !retried.firstPageMissing) return { note: options.emptyNote };
      throw error;
    }
    if (count(user) === 0) return explain(0, true);
    const retried = await retry();
    if (retried.items.length > 0 || retried.hasMore) return retried;
    return explain(count(user), retried.firstPageMissing);
  };
}

/**
 * The profile lookup behind the U11 diagnosis: 404 -> not_found/suspended, protected -> restricted.
 * retryNotFound asks once more after a "not found", which the upstream occasionally returns for existing accounts.
 */
async function lookUpAccount(session: UpstreamSession, handle: string, retryNotFound = false): Promise<Rec> {
  const route = routes.profile(handle, { aboutAccount: false });
  let outcome;
  try {
    outcome = await session.fetch(route, { handle });
  } catch (error) {
    if (!retryNotFound || !(error instanceof ToolError) || error.code !== 'not_found') throw error;
    outcome = await session.fetch(route, { handle });
  }
  const user = outcome.kind === 'ok' ? rec(outcome.body.user) : undefined;
  if (user === undefined) throw unexpectedResponse();
  if (user.protected === true) throw accountProtected(handle);
  return user;
}

/**
 * Account timelines answer HTTP 500 with an empty list for protected accounts; the profile tells them apart.
 * Timeline + profile + one profile retry stays within the 3-request cap.
 */
const checkAccountOnServerError =
  (session: UpstreamSession, handle: string): FirstPageServerError =>
  async () => {
    await lookUpAccount(session, handle, true);
  };

/** For lists without an account behind them: a first page that answered "not found" is asked for once more. */
const emptyUnlessMissing =
  (note: string): EmptyFirstPage =>
  async (retry, first) => {
    const result = first.firstPageMissing ? await retry() : first;
    if (result.items.length > 0 || result.hasMore) return result;
    if (result.firstPageMissing) throw pageMissing();
    return { note };
  };

const projectListPost = (raw: unknown) => projectPost(raw, 'list');
const projectListUser = (raw: unknown): User => projectUser(raw);

export async function getProfileStatuses(args: ToolArgs<'get_profile_statuses'>, { session }: ToolContext) {
  const handle = parseHandleRef(args.handle);
  const withReplies = args.include_replies;
  return listPage({
    session,
    kind: POSTS,
    scope: scopeKey({ tool: 'get_profile_statuses', handle, includeReplies: withReplies }),
    cursor: args.cursor,
    count: args.count,
    format: args.response_format,
    route: (up) => routes.statuses(handle, { cursor: up, withReplies }),
    context: { handle },
    project: projectListPost,
    tooLarge: tooLargePost,
    onEmptyFirstPage: diagnoseAccount(session, handle, {
      emptyNote: `@${handle} has no posts.`,
      counter: 'statuses',
      what: 'posts',
      // The statuses counter includes replies, so a reply-only account has an empty default timeline.
      ...(withReplies ? {} : { listedButEmptyNote: (listed: number) => notes.noPostsWithoutReplies(handle, listed) })
    }),
    onFirstPageServerError: checkAccountOnServerError(session, handle)
  });
}

export async function getProfileMedia(args: ToolArgs<'get_profile_media'>, { session }: ToolContext) {
  const handle = parseHandleRef(args.handle);
  return listPage({
    session,
    kind: POSTS,
    scope: scopeKey({ tool: 'get_profile_media', handle }),
    cursor: args.cursor,
    count: args.count,
    format: args.response_format,
    route: (up) => routes.media(handle, { cursor: up }),
    context: { handle },
    project: projectListPost,
    tooLarge: tooLargePost,
    onEmptyFirstPage: diagnoseAccount(session, handle, {
      emptyNote: `@${handle} has no posts with photos or videos.`,
      counter: 'media_count',
      what: 'media posts'
    }),
    onFirstPageServerError: checkAccountOnServerError(session, handle)
  });
}

export async function getProfileArticles(args: ToolArgs<'get_profile_articles'>, { session }: ToolContext) {
  const handle = parseHandleRef(args.handle);
  return listPage({
    session,
    kind: POSTS,
    scope: scopeKey({ tool: 'get_profile_articles', handle }),
    cursor: args.cursor,
    count: args.count,
    format: args.response_format,
    route: (up) => routes.articles(handle, { cursor: up }),
    context: { handle },
    project: projectListPost,
    tooLarge: tooLargePost,
    onEmptyFirstPage: diagnoseAccount(session, handle, { emptyNote: `@${handle} has no Articles.`, what: 'Articles' }),
    onFirstPageServerError: checkAccountOnServerError(session, handle)
  });
}

export async function getProfileFollowers(args: ToolArgs<'get_profile_followers'>, { session }: ToolContext) {
  const handle = parseHandleRef(args.handle);
  return listPage({
    session,
    kind: USERS,
    scope: scopeKey({ tool: 'get_profile_followers', handle }),
    cursor: args.cursor,
    count: args.count,
    format: args.response_format,
    route: (up) => routes.followers(handle, { cursor: up }),
    context: { handle },
    project: projectListUser,
    onEmptyFirstPage: diagnoseAccount(session, handle, { emptyNote: `@${handle} has no followers.`, counter: 'followers', what: 'followers' }),
    onFirstPageServerError: checkAccountOnServerError(session, handle)
  });
}

export async function getProfileFollowing(args: ToolArgs<'get_profile_following'>, { session }: ToolContext) {
  const handle = parseHandleRef(args.handle);
  return listPage({
    session,
    kind: USERS,
    scope: scopeKey({ tool: 'get_profile_following', handle }),
    cursor: args.cursor,
    count: args.count,
    format: args.response_format,
    route: (up) => routes.following(handle, { cursor: up }),
    context: { handle },
    project: projectListUser,
    onEmptyFirstPage: diagnoseAccount(session, handle, {
      emptyNote: `@${handle} follows no accounts.`,
      counter: 'following',
      what: 'followed accounts'
    }),
    onFirstPageServerError: checkAccountOnServerError(session, handle)
  });
}

export async function getPostReposts(args: ToolArgs<'get_post_reposts'>, { session }: ToolContext) {
  const postId = parsePostRef(args.id);
  return listPage({
    session,
    kind: USERS,
    scope: scopeKey({ tool: 'get_post_reposts', postId }),
    cursor: args.cursor,
    count: args.count,
    format: args.response_format,
    route: (up) => routes.reposts(postId, { cursor: up }),
    context: { postId },
    project: projectListUser,
    onEmptyFirstPage: emptyUnlessMissing(notes.noReposts),
    // Reposts of an unknown or deleted post answer HTTP 500; the post itself answers 404 (not_found).
    onFirstPageServerError: async () => {
      const outcome = await session.fetch(routes.status(postId), { postId });
      const status = outcome.kind === 'ok' ? rec(outcome.body.status) : undefined;
      if (status !== undefined && status.type !== undefined && status.type !== 'status') {
        throw isRestricted(status.reason) ? postRestricted(postId) : postNotFound(postId);
      }
    }
  });
}

export async function searchPosts(args: ToolArgs<'search_posts'>, { session }: ToolContext) {
  const q = args.q.trim();
  if (q === '') throw emptyQuery('search_posts');
  const feed = args.feed;
  return listPage({
    session,
    kind: POSTS,
    scope: scopeKey({ tool: 'search_posts', feed, q }),
    cursor: args.cursor,
    count: args.count,
    format: args.response_format,
    route: (up) => routes.search({ q, feed, cursor: up }),
    context: { q },
    project: projectListPost,
    tooLarge: tooLargePost,
    onEmptyFirstPage: emptyUnlessMissing(notes.noSearchResults)
  });
}

// ---------------------------------------------------------------------------------------------
// Unpaginated tools

export async function typeahead(args: ToolArgs<'typeahead'>, { session }: ToolContext) {
  const q = args.q.trim();
  if (q === '') throw emptyQuery('typeahead');
  const outcome = await session.fetch(routes.typeahead({ q }), { q });
  const body = outcome.kind === 'ok' ? outcome.body : {};
  const users = arr(body.users).slice(0, args.count).map(projectTypeaheadUser);
  const topics = arr(body.topics)
    .map((entry) => rec(entry)?.topic)
    .filter((topic): topic is string => typeof topic === 'string' && topic !== '')
    .slice(0, args.count);
  const result: Rec = { users, topics };
  if (users.length === 0 && topics.length === 0) result.note = notes.noSuggestions;
  return result;
}

export async function getTrends(args: ToolArgs<'get_trends'>, { session }: ToolContext) {
  const outcome = await session.fetch(routes.trends({ count: Math.min(args.count, TRENDS_UPSTREAM_MAX) }), {});
  const trends = (outcome.kind === 'ok' ? arr(outcome.body.trends) : []).slice(0, Math.min(args.count, TRENDS_UPSTREAM_MAX)).map(projectTrend);
  const parts: string[] = [];
  if (trends.length === 0) parts.push(notes.noTrends);
  if (args.count > TRENDS_UPSTREAM_MAX) parts.push(notes.trendsClamped);
  const result: Rec = { trends, returned: trends.length };
  if (parts.length > 0) result.note = parts.join(' ');
  return result;
}

export async function getOpenapi(_args: ToolArgs<'get_openapi'>, { config }: ToolContext) {
  const search = config.searchEnabled;
  const endpoints: [string, string, boolean][] = [
    ['search_posts', 'GET /2/search', search],
    ['get_post', 'GET /2/status/{id}', true],
    ['get_profile', 'GET /2/profile/{handle}', true],
    ['get_profile_statuses', 'GET /2/profile/{handle}/statuses', true],
    ['get_profile_media', 'GET /2/profile/{handle}/media', true],
    ['get_trends', 'GET /2/trends', true],
    ['typeahead', 'GET /2/typeahead', search],
    ['get_profile_articles', 'GET /2/profile/{handle}/articles', true],
    ['get_profile_followers', 'GET /2/profile/{handle}/followers', true],
    ['get_profile_following', 'GET /2/profile/{handle}/following', true],
    ['get_post_reposts', 'GET /2/status/{id}/reposts', true]
  ];
  return {
    deprecated:
      'get_openapi no longer returns the upstream OpenAPI document and will be removed in a future version; tools/list describes every tool.',
    upstream_base: `${config.upstreamBaseUrl}/2`,
    tools: endpoints.map(([name, endpoint, available]) => ({ name, endpoint, available }))
  };
}
