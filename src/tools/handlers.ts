/**
 * Thin tool handlers: normalize input -> fetch -> classify -> paginate/project -> envelope.
 * They return the success envelope or throw ToolError; serialization happens in server.ts.
 */
import type { Config } from '../config';
import type { PostItem, User } from '../contract/envelopes';
import { ITEM_BUDGET, MAX_RESULT_CHARS, TRENDS_UPSTREAM_MAX } from '../contract/limits';
import {
  accountProtected,
  emptyQuery,
  notes,
  postNotFound,
  postRestricted,
  timelineMissing,
  unexpectedResponse
} from '../contract/messages';
import type { ResponseFormat, ToolArgs } from '../contract/tools';
import { decodeCursor, encodeCursor, scopeKey } from '../domain/cursor';
import { parseHandleRef, parsePostRef } from '../domain/normalize';
import { paginate, type Page, type PaginateResult } from '../domain/paginate';
import { projectPost, projectTrend, projectTypeaheadUser, projectUser, stripMosaic } from '../domain/project';
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
    throw RESTRICTED_REASONS.has(String(status.reason)) ? postRestricted(postId) : postNotFound(postId);
  }
  if (args.response_format === 'detailed') {
    const detailed = { post: stripMosaic(status) };
    if (fits(detailed, MAX_RESULT_CHARS)) return detailed;
    return { post: conciseSinglePost(status), note: notes.detailedTooLarge };
  }
  return { post: conciseSinglePost(status) };
}

function conciseSinglePost(raw: Rec): PostItem {
  const post = projectPost(raw, 'single');
  return fits(post, ITEM_BUDGET) ? post : projectPost(raw, 'single', OVERSIZED_SINGLE_LIMITS);
}

export async function getProfile(args: ToolArgs<'get_profile'>, { session }: ToolContext) {
  const handle = parseHandleRef(args.handle);
  const outcome = await session.fetch(routes.profile(handle, { aboutAccount: args.include_about }), { handle });
  const user = outcome.kind === 'ok' ? rec(outcome.body.user) : undefined;
  if (user === undefined) throw unexpectedResponse();
  const note = user.protected === true ? notes.protectedProfile : undefined;
  const projected: unknown =
    args.response_format === 'detailed' && fits({ user: stripMosaic(user) }, MAX_RESULT_CHARS)
      ? stripMosaic(user)
      : projectUser(user, { includeAbout: args.include_about });
  return note === undefined ? { user: projected } : { user: projected, note };
}

// ---------------------------------------------------------------------------------------------
// Lists

type ListKind = { key: 'posts' | 'users'; plural: string; singular: string };
const POSTS: ListKind = { key: 'posts', plural: 'posts', singular: 'post' };
const USERS: ListKind = { key: 'users', plural: 'accounts', singular: 'account' };

type EmptyFirstPage = (retry: () => Promise<PaginateResult<unknown>>) => Promise<PaginateResult<unknown> | { note: string }>;

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
  onEmptyFirstPage: EmptyFirstPage;
};

async function listPage(request: ListRequest): Promise<Rec> {
  const { session, kind, scope, count, format } = request;
  const state = decodeCursor(request.cursor, scope);
  let detailedFellBack = false;
  const project = (raw: unknown) => {
    if (format === 'concise') return request.project(raw);
    const detailed = stripMosaic(raw);
    if (fits(detailed, ITEM_BUDGET)) return detailed;
    detailedFellBack = true;
    return request.project(raw);
  };
  const fetchPage = async (up: string | null): Promise<Page> => {
    const outcome = await session.fetch(request.route(up), request.context);
    if (outcome.kind === 'empty') return { items: [], bottom: null };
    const bottom = rec(outcome.body.cursor)?.bottom;
    return { items: arr(outcome.body.results), bottom: typeof bottom === 'string' && bottom !== '' ? bottom : null };
  };
  const run = () => paginate({ state, count, fetchPage, project });

  let result = await run();
  if (result.firstPageEmpty) {
    const diagnosed = await request.onEmptyFirstPage(run);
    if ('note' in diagnosed) return { [kind.key]: [], returned: 0, has_more: false, note: diagnosed.note };
    result = diagnosed;
  }
  return listEnvelope(kind, scope, count, result, detailedFellBack);
}

function listEnvelope(kind: ListKind, scope: string, count: number, result: PaginateResult<unknown>, detailedFellBack: boolean): Rec {
  const returned = result.items.length;
  const envelope: Rec = { [kind.key]: result.items, returned, has_more: result.hasMore };
  if (result.hasMore && result.next !== undefined) envelope.next_cursor = encodeCursor(scope, result.next);
  if (result.truncated) envelope.truncated = true;
  const parts: string[] = [];
  if (result.truncated) parts.push(notes.budget(returned, kind.plural));
  else if (result.pageEnded) parts.push(notes.pageEnded(returned, count));
  if (result.shifted) parts.push(notes.pageShifted(kind.singular));
  if (result.endOfList && returned === 0) parts.push(notes.noMore(kind.plural));
  if (detailedFellBack) parts.push(notes.detailedTooLarge);
  if (parts.length > 0) envelope.note = parts.join(' ');
  return envelope;
}

/**
 * U11: an empty first page (or a 404) is identical for an unknown account, a suspended or protected one, a truly
 * empty one and a transient upstream failure. One profile lookup tells them apart; one retry covers the transient case.
 */
function diagnoseAccount(
  session: UpstreamSession,
  handle: string,
  options: { emptyNote: string; counter?: 'statuses' | 'media_count' | 'followers' | 'following'; what: string }
): EmptyFirstPage {
  return async (retry) => {
    const outcome = await session.fetch(routes.profile(handle, { aboutAccount: false }), { handle });
    const user = outcome.kind === 'ok' ? rec(outcome.body.user) : undefined;
    if (user === undefined) throw unexpectedResponse();
    if (user.protected === true) throw accountProtected(handle);
    const listed = options.counter === undefined ? undefined : num(user[options.counter]);
    if (listed === undefined || listed === 0) return { note: options.emptyNote };
    const retried = await retry();
    if (retried.items.length > 0 || retried.hasMore) return retried;
    throw timelineMissing(handle, options.what, listed);
  };
}

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
    onEmptyFirstPage: diagnoseAccount(session, handle, { emptyNote: `@${handle} has no posts.`, counter: 'statuses', what: 'posts' })
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
    onEmptyFirstPage: diagnoseAccount(session, handle, {
      emptyNote: `@${handle} has no posts with photos or videos.`,
      counter: 'media_count',
      what: 'media posts'
    })
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
    onEmptyFirstPage: diagnoseAccount(session, handle, { emptyNote: `@${handle} has no Articles.`, what: 'Articles' })
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
    onEmptyFirstPage: diagnoseAccount(session, handle, { emptyNote: `@${handle} has no followers.`, counter: 'followers', what: 'followers' })
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
    })
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
    onEmptyFirstPage: async () => ({ note: notes.noReposts })
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
    onEmptyFirstPage: async () => ({ note: notes.noSearchResults })
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
  const trends = (outcome.kind === 'ok' ? arr(outcome.body.trends) : []).slice(0, args.count).map(projectTrend);
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
