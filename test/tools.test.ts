import { describe, expect, it } from 'vitest';
import {
  ErrorPayloadSchema,
  PostResultSchema,
  TrendsResultSchema,
  TypeaheadResultSchema,
  UserListSchema,
  UserResultSchema,
  PostListSchema
} from '../src/contract/envelopes';
import { MAX_RESULT_CHARS } from '../src/contract/limits';
import { TOOL_NAMES } from '../src/contract/tools';
import { stripMosaic } from '../src/domain/project';
import { call, connect, fakeUpstream, json, timelinePage } from './helpers';
import articles from './fixtures/articles.json';
import about from './fixtures/about.json';
import profile from './fixtures/profile.json';
import searchUnavailable from './fixtures/error-search-unavailable.json';
import status from './fixtures/status.json';
import trends from './fixtures/trends.json';
import typeaheadFixture from './fixtures/typeahead.json';
import userNotFound from './fixtures/error-user-not-found.json';
import users from './fixtures/users.json';

const BRAND_RE = /fx\s*twitter/i;

describe('tools/list', () => {
  it('lists every tool in contract order with read-only annotations', async () => {
    const client = await connect(fakeUpstream(() => json({})).fetch);
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    }
  });

  it('advertises defaults in the JSON Schema even with null-tolerant optional params', async () => {
    const client = await connect(fakeUpstream(() => json({})).fetch);
    const { tools } = await client.listTools();
    const statusesTool = tools.find((tool) => tool.name === 'get_profile_statuses')!;
    const properties = statusesTool.inputSchema.properties as Record<string, Record<string, unknown>>;

    expect(properties.count).toMatchObject({ type: 'integer', minimum: 1, maximum: 100, default: 10 });
    expect(properties.response_format).toMatchObject({ enum: ['concise', 'detailed'], default: 'concise' });
    expect(properties.include_replies).toMatchObject({ type: 'boolean', default: false });
    expect(statusesTool.inputSchema.required).toEqual(['handle']);
  });
});

describe('get_post', () => {
  const upstream = () =>
    fakeUpstream((url) => {
      if (url.pathname.endsWith('/2/status/2000000000000000100')) return json(status);
      if (url.pathname.endsWith('/2/status/404404404')) return json({ code: 404, message: 'Not found' }, 404);
      if (url.pathname.endsWith('/2/status/77')) return json({ code: 200, status: { type: 'tombstone', reason: 'protected', id: '77' } });
      return json({}, 500);
    });

  it('accepts a post URL and returns the concise post', async () => {
    const fake = upstream();
    const result = await call(await connect(fake.fetch), 'get_post', { id: 'https://x.com/example_dev/status/2000000000000000100?s=20' });

    expect(result.isError).toBe(false);
    expect(fake.paths()).toEqual(['/2/status/2000000000000000100']);
    const parsed = PostResultSchema.parse(result.data);
    expect(parsed.post).toMatchObject({ id: '2000000000000000100', author: { handle: 'example_dev' }, metrics: { likes: 567 } });
    expect(result.text).not.toMatch(BRAND_RE);
    expect(result.text).not.toContain('\n');
  });

  it('returns the upstream object without mosaic in detailed mode', async () => {
    const result = await call(await connect(upstream().fetch), 'get_post', { id: '2000000000000000100', response_format: 'detailed' });

    expect(result.data.post).toMatchObject({ id: '2000000000000000100', raw_text: expect.any(Object) });
    expect(result.text).not.toContain('mosaic');
  });

  it('rejects bad ids before calling upstream', async () => {
    const fake = upstream();
    const result = await call(await connect(fake.fetch), 'get_post', { id: 'https://x.com/nasa' });

    expect(result.isError).toBe(true);
    expect(ErrorPayloadSchema.parse(result.data)).toMatchObject({ code: 'invalid_argument', retryable: false });
    expect(fake.urls).toHaveLength(0);
  });

  it('maps missing and restricted posts', async () => {
    const client = await connect(upstream().fetch);

    expect((await call(client, 'get_post', { id: '404404404' })).data).toMatchObject({ code: 'not_found', upstream_status: 404 });
    expect((await call(client, 'get_post', { id: '77' })).data).toMatchObject({ code: 'restricted' });
  });

  it('reports schema errors in the same JSON error envelope', async () => {
    const client = await connect(upstream().fetch);

    const wrongType = await call(client, 'get_post', { id: 20 });
    expect(wrongType.isError).toBe(true);
    expect(ErrorPayloadSchema.parse(wrongType.data)).toMatchObject({ code: 'invalid_argument', retryable: false });
    expect(wrongType.data.error).toContain('id must be a string');
    expect(wrongType.data.error).not.toMatch(/^MCP error/);

    const outOfRange = await call(client, 'get_profile_statuses', { handle: 'jack', count: 200 });
    expect(ErrorPayloadSchema.parse(outOfRange.data).error).toContain('count must be a whole number from 1 to 100');

    for (const name of ['no_such_tool', 'get post', 'Tool x not found']) {
      const unknown = await call(client, name, {});
      expect(ErrorPayloadSchema.parse(unknown.data)).toEqual({
        error: 'Unknown tool name.',
        code: 'invalid_argument',
        retryable: false,
        hint: 'Use one of the tool names from tools/list.'
      });
    }
  });
});

describe('get_profile', () => {
  it('returns the concise profile and adds about only when asked', async () => {
    const fake = fakeUpstream((url) =>
      json(url.searchParams.get('about_account') === '1' ? { ...profile, user: { ...profile.user, about_account: about.about_account } } : profile)
    );
    const client = await connect(fake.fetch);

    const plain = await call(client, 'get_profile', { handle: '@example_dev' });
    const withAbout = await call(client, 'get_profile', { handle: 'https://x.com/example_dev', include_about: true });

    expect(UserResultSchema.parse(plain.data).user).toMatchObject({ handle: 'example_dev', followers: 98765 });
    expect(plain.data.user).not.toHaveProperty('about');
    expect(UserResultSchema.parse(withAbout.data).user.about).toMatchObject({ based_in: 'Japan', username_changes: 1 });
    expect(fake.paths()).toEqual(['/2/profile/example_dev', '/2/profile/example_dev?about_account=1']);
  });

  it('retries a profile 404 once, because the upstream sometimes answers not found for existing accounts', async () => {
    let calls = 0;
    const flaky = fakeUpstream(() => (calls++ === 0 ? json(userNotFound, 404) : json(profile)));
    const result = await call(await connect(flaky.fetch), 'get_profile', { handle: 'example_dev' });

    expect(result.data).toMatchObject({ user: { handle: 'example_dev' } });
    expect(flaky.urls).toHaveLength(2);

    const missing = fakeUpstream(() => json(userNotFound, 404));
    const notFound = await call(await connect(missing.fetch), 'get_profile', { handle: 'nobody' });
    expect(notFound.data).toMatchObject({ code: 'not_found', retryable: true });
    expect(missing.urls).toHaveLength(2);
  });

  it('notes protected accounts and maps unknown and suspended ones', async () => {
    const fake = fakeUpstream((url) => {
      if (url.pathname.endsWith('/locked')) return json({ ...profile, user: { ...profile.user, screen_name: 'locked', protected: true } });
      if (url.pathname.endsWith('/gone')) return json({ ...userNotFound, reason: 'suspended' }, 404);
      return json(userNotFound, 404);
    });
    const client = await connect(fake.fetch);

    expect((await call(client, 'get_profile', { handle: 'locked' })).data.note).toMatch(/protected/);
    expect((await call(client, 'get_profile', { handle: 'nobody' })).data).toMatchObject({ code: 'not_found' });
    expect((await call(client, 'get_profile', { handle: 'gone' })).data).toMatchObject({ code: 'restricted' });
  });
});

describe('get_profile_statuses', () => {
  it('enforces count, keeps results small and continues losslessly with next_cursor', async () => {
    const pages = {
      first: timelinePage({ bottom: 'PAGE-2' }),
      second: timelinePage({ startId: 3000000000000000100n, bottom: 'PAGE-3' })
    };
    const fake = fakeUpstream((url) => {
      const cursor = url.searchParams.get('cursor');
      if (cursor === null) return json(pages.first);
      if (cursor === 'PAGE-2') return json(pages.second);
      return json({ code: 200, results: [], cursor: { bottom: 'END' } });
    });
    const client = await connect(fake.fetch);

    const first = await call(client, 'get_profile_statuses', { handle: 'example_dev', count: 10 });
    const list = PostListSchema.parse(first.data);
    expect(list).toMatchObject({ returned: 10, has_more: true });
    expect(first.text.length).toBeLessThan(12_000);

    const seen = [...list.posts.map((post) => post.id)];
    let cursor = list.next_cursor;
    for (let i = 0; i < 10 && cursor !== undefined; i++) {
      const next = PostListSchema.parse((await call(client, 'get_profile_statuses', { handle: 'example_dev', count: 7, cursor })).data);
      seen.push(...next.posts.map((post) => post.id));
      cursor = next.next_cursor;
    }
    const expected = [...pages.first.results, ...pages.second.results].map((post) => post.id);
    expect(seen).toEqual(expected);
    expect(fake.urls.every((url) => !url.searchParams.has('count'))).toBe(true);
  });

  it('accepts null optionals, legacy upstream cursors and include_replies', async () => {
    const fake = fakeUpstream(() => json(timelinePage()));
    const client = await connect(fake.fetch);

    const result = await call(client, 'get_profile_statuses', {
      handle: 'jack',
      count: null,
      cursor: 'DAAHCgABHYHlojO__-oLAAIAAAA',
      include_replies: true,
      response_format: null
    });

    expect(result.isError).toBe(false);
    expect(result.data.returned).toBe(10);
    expect(fake.paths()).toEqual(['/2/profile/jack/statuses?cursor=DAAHCgABHYHlojO__-oLAAIAAAA&with_replies=1']);
  });

  it('forwards a 0.1 cursor string verbatim', async () => {
    const fake = fakeUpstream(() => json(timelinePage()));
    await call(await connect(fake.fetch), 'get_profile_statuses', { handle: 'jack', cursor: 'page two' });

    expect(fake.urls[0]?.searchParams.get('cursor')).toBe('page two');
  });

  it('keeps detailed results under 30,000 characters even with the longest cursor', async () => {
    const page = timelinePage({ size: 3, bottom: 'b'.repeat(512) });
    for (const item of page.results) {
      const raw = item as Record<string, unknown>;
      raw.text = '';
      raw.text = 'w'.repeat(14_200 - JSON.stringify(stripMosaic(raw)).length);
    }
    const client = await connect(fakeUpstream(() => json(page)).fetch);
    for (const cursor of [undefined, '\u0001'.repeat(500)]) {
      const result = await call(client, 'get_profile_statuses', { handle: 'jack', count: 3, response_format: 'detailed', ...(cursor ? { cursor } : {}) });
      expect(result.isError).toBe(false);
      expect(result.text.length).toBeLessThanOrEqual(30_000);
      expect(result.data.next_cursor).toEqual(expect.any(String));
    }
  });

  it('rejects a cursor issued for another account', async () => {
    const client = await connect(fakeUpstream(() => json(timelinePage())).fetch);
    const first = await call(client, 'get_profile_statuses', { handle: 'jack', count: 1 });

    const misuse = await call(client, 'get_profile_statuses', { handle: 'nasa', cursor: first.data.next_cursor });
    expect(misuse.data).toMatchObject({ code: 'invalid_cursor', error: 'This cursor was issued for get_profile_statuses for @jack, not for this call.' });
  });

  it('diagnoses an empty first page with one profile lookup', async () => {
    const respond = (profileUser: Record<string, unknown>, timeline: () => Response) =>
      fakeUpstream((url) => (url.pathname.endsWith('/statuses') ? timeline() : json({ ...profile, user: { ...profile.user, ...profileUser } })));
    const empty = () => json({ code: 200, results: [], cursor: { bottom: 'X' } });

    const none = await call(await connect(respond({ statuses: 0 }, empty).fetch), 'get_profile_statuses', { handle: 'quiet' });
    expect(none.data).toEqual({ posts: [], returned: 0, has_more: false, note: '@quiet has no posts.' });

    const locked = await call(await connect(respond({ protected: true }, empty).fetch), 'get_profile_statuses', { handle: 'locked' });
    expect(locked.data).toMatchObject({ code: 'restricted' });

    const unknown = fakeUpstream(() => json(userNotFound, 404));
    expect((await call(await connect(unknown.fetch), 'get_profile_statuses', { handle: 'nobody' })).data).toMatchObject({ code: 'not_found' });

    let calls = 0;
    const flaky = respond({ statuses: 5 }, () => (calls++ === 0 ? json(userNotFound, 404) : json(timelinePage({ size: 3 }))));
    const recovered = await call(await connect(flaky.fetch), 'get_profile_statuses', { handle: 'flaky' });
    expect(recovered.data).toMatchObject({ returned: 3 });
    expect(flaky.urls).toHaveLength(3);

    const broken = await call(await connect(respond({ statuses: 5 }, empty).fetch), 'get_profile_statuses', {
      handle: 'broken',
      include_replies: true
    });
    expect(broken.data).toMatchObject({ code: 'upstream_unavailable', retryable: true });
  });

  it('treats an empty default timeline of an account with only replies as a success with a hint', async () => {
    const fake = fakeUpstream((url) =>
      url.pathname.endsWith('/statuses')
        ? json({ code: 200, results: [], cursor: { bottom: 'X' } })
        : json({ ...profile, user: { ...profile.user, statuses: 7 } })
    );
    const result = await call(await connect(fake.fetch), 'get_profile_statuses', { handle: 'replier' });

    expect(result.data).toEqual({
      posts: [],
      returned: 0,
      has_more: false,
      note: 'X returned no posts without replies for @replier, although its profile lists 7 posts; try include_replies=true.'
    });
    expect(fake.urls).toHaveLength(3);
  });

  it('reports protected accounts as restricted when the upstream answers the timeline with HTTP 500', async () => {
    const serverError = () => json({ code: 500, results: [], cursor: { top: null, bottom: null } }, 500);
    for (const tool of ['get_profile_statuses', 'get_profile_media', 'get_profile_articles', 'get_profile_followers', 'get_profile_following']) {
      const fake = fakeUpstream((url) =>
        /\/(statuses|media|articles|followers|following)$/.test(url.pathname)
          ? serverError()
          : json({ ...profile, user: { ...profile.user, screen_name: 'locked', protected: true } })
      );
      const result = await call(await connect(fake.fetch), tool, { handle: 'locked' });
      expect(result.data, tool).toMatchObject({ code: 'restricted', retryable: false });
      expect(fake.urls, tool).toHaveLength(2);
    }

    let profileCalls = 0;
    const flakyProfile = fakeUpstream((url) => {
      if (url.pathname.endsWith('/statuses')) return serverError();
      return profileCalls++ === 0 ? json(userNotFound, 404) : json({ ...profile, user: { ...profile.user, protected: true } });
    });
    expect((await call(await connect(flakyProfile.fetch), 'get_profile_statuses', { handle: 'locked' })).data).toMatchObject({
      code: 'restricted'
    });
    expect(flakyProfile.urls).toHaveLength(3);

    const publicAccount = fakeUpstream((url) => (url.pathname.endsWith('/statuses') ? serverError() : json(profile)));
    expect((await call(await connect(publicAccount.fetch), 'get_profile_statuses', { handle: 'example_dev' })).data).toMatchObject({
      code: 'upstream_unavailable',
      retryable: true,
      upstream_status: 500
    });
  });

  it('notes a concise fallback in detailed mode only when such an item is returned', async () => {
    const page = timelinePage({ size: 2 });
    (page.results[1] as Record<string, unknown>).text = 'y'.repeat(30_000);
    const both = await call(await connect(fakeUpstream(() => json(page)).fetch), 'get_profile_statuses', {
      handle: 'jack',
      count: 2,
      response_format: 'detailed'
    });
    expect(both.data.note).toBe('Posts too large for detailed form are returned in concise form.');

    // The first item nearly fills the budget, so the oversized second item is projected (concise) but not returned.
    const deferred = timelinePage({ size: 2 });
    const first = deferred.results[0] as Record<string, unknown>;
    first.text = '';
    first.text = 'z'.repeat(28_500 - JSON.stringify(stripMosaic(first)).length);
    (deferred.results[1] as Record<string, unknown>).text = 'y'.repeat(30_000);
    const result = await call(await connect(fakeUpstream(() => json(deferred)).fetch), 'get_profile_statuses', {
      handle: 'jack',
      count: 2,
      response_format: 'detailed'
    });
    expect(result.data).toMatchObject({ returned: 1, truncated: true });
    expect(result.data.note).toBe('Stopped at 1 posts to keep this result under 30,000 characters; pass next_cursor as cursor for the rest.');
  });

  it('keeps detailed pages under the result budget', async () => {
    const client = await connect(fakeUpstream(() => json(timelinePage({ longText: true }))).fetch);
    const result = await call(client, 'get_profile_statuses', { handle: 'jack', count: 100, response_format: 'detailed' });

    const page = result.data as { posts: Record<string, unknown>[]; returned: number; truncated?: boolean; note?: string };
    expect(result.text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(result.text).not.toContain('mosaic');
    expect(page.posts[0]).toHaveProperty('raw_text');
    expect(page).toMatchObject({ truncated: true, has_more: true });
    expect(page.returned).toBeLessThan(20);
    expect(page.note).toMatch(/^Stopped at \d+ posts to keep this result under 30,000 characters/);
  });
});

describe('other list tools', () => {
  it('get_profile_media, get_profile_articles, followers, following and reposts', async () => {
    const fake = fakeUpstream((url) => {
      if (url.pathname.endsWith('/media')) return json(timelinePage({ size: 4 }));
      if (url.pathname.endsWith('/articles')) return json(articles);
      if (url.pathname.endsWith('/followers') || url.pathname.endsWith('/following') || url.pathname.endsWith('/reposts')) return json(users);
      return json({}, 500);
    });
    const client = await connect(fake.fetch);

    const media = PostListSchema.parse((await call(client, 'get_profile_media', { handle: 'example_dev' })).data);
    const posts = PostListSchema.parse((await call(client, 'get_profile_articles', { handle: 'example_dev' })).data);
    const followers = UserListSchema.parse((await call(client, 'get_profile_followers', { handle: 'example_dev', count: 2 })).data);
    const following = UserListSchema.parse((await call(client, 'get_profile_following', { handle: 'example_dev' })).data);
    const reposts = UserListSchema.parse((await call(client, 'get_post_reposts', { id: 'https://x.com/jack/status/20' })).data);

    expect(media.returned).toBe(4);
    expect(posts.posts[0]).toMatchObject({ article: { title: 'Notes on tiny servers' } });
    expect(followers).toMatchObject({ returned: 2, has_more: true });
    expect(following.users.map((user) => user.handle)).toEqual(['sample_news', 'test_reposter', 'third_user']);
    expect(reposts.returned).toBe(3);
    expect(fake.paths()).toContain('/2/status/20/reposts');
  });

  it('maps reposts of an unknown post to not_found even though the upstream answers HTTP 500', async () => {
    const fake = fakeUpstream((url) =>
      url.pathname.endsWith('/reposts')
        ? json({ code: 500, results: [], cursor: { top: null, bottom: null } }, 500)
        : json({ status: null, thread: null, author: null, code: 404 }, 404)
    );
    const result = await call(await connect(fake.fetch), 'get_post_reposts', { id: '2126276112015639014' });

    expect(result.data).toMatchObject({ code: 'not_found', retryable: false });
    expect(fake.paths()).toEqual(['/2/status/2126276112015639014/reposts', '/2/status/2126276112015639014']);
  });

  it('reports an empty reposts list as a success with a note', async () => {
    const client = await connect(fakeUpstream(() => json({ code: 200, results: [], cursor: { bottom: 'x' } })).fetch);

    expect((await call(client, 'get_post_reposts', { id: '20' })).data).toEqual({
      users: [],
      returned: 0,
      has_more: false,
      note: 'No reposts were returned for this post.'
    });
  });
});

describe('search_posts and typeahead', () => {
  it('turns the upstream 503 into feature_unavailable with a concrete alternative', async () => {
    const fake = fakeUpstream(() => json(searchUnavailable, 503));
    const client = await connect(fake.fetch);

    const search = await call(client, 'search_posts', { q: 'from:jack', feed: 'latest', count: 2 });
    expect(ErrorPayloadSchema.parse(search.data)).toMatchObject({
      code: 'feature_unavailable',
      retryable: false,
      hint: 'This query asks for posts from @jack: call get_profile_statuses with {"handle":"jack","count":10} and filter the results yourself.'
    });
    expect(fake.paths()[0]).toBe('/2/search?q=from%3Ajack&feed=latest');

    const typeahead = await call(client, 'typeahead', { q: 'jack' });
    expect(typeahead.data).toMatchObject({ code: 'feature_unavailable' });
  });

  it('returns search results and typeahead suggestions when upstream works', async () => {
    const fake = fakeUpstream((url) => (url.pathname.endsWith('/typeahead') ? json(typeaheadFixture) : json(timelinePage({ size: 3 }))));
    const client = await connect(fake.fetch, { UPSTREAM_BASE_URL: 'https://upstream.test/api/fx', SEARCH_ENABLED: 'true' });

    expect(PostListSchema.parse((await call(client, 'search_posts', { q: ' nasa ' })).data).returned).toBe(3);
    expect(TypeaheadResultSchema.parse((await call(client, 'typeahead', { q: 'exam', count: 1 })).data)).toEqual({
      users: [{ handle: 'example_dev', name: 'Example Dev', verified: true, followers: 98765 }],
      topics: ['example topic']
    });
    expect((await call(client, 'search_posts', { q: '   ' })).data).toMatchObject({ code: 'invalid_argument', error: 'q is empty.' });
  });
});

describe('get_trends and get_openapi', () => {
  it('clamps count to the upstream maximum and slices the result', async () => {
    const fake = fakeUpstream(() => json(trends));
    const client = await connect(fake.fetch);

    const result = await call(client, 'get_trends', { count: 100 });
    expect(TrendsResultSchema.parse(result.data)).toMatchObject({ returned: 3, note: 'count was reduced to 50, the upstream maximum.' });
    expect(fake.paths()).toEqual(['/2/trends?count=50']);
    expect((await call(client, 'get_trends', { count: 2 })).data.returned).toBe(2);
  });

  it('treats no trends as a success', async () => {
    const client = await connect(fakeUpstream(() => json({ code: 200, trends: [] })).fetch);

    expect((await call(client, 'get_trends')).data).toEqual({
      trends: [],
      returned: 0,
      note: 'The upstream returned no trends right now; this is not an error in your request.'
    });
  });

  it('returns a static capability summary without calling upstream', async () => {
    const fake = fakeUpstream(() => json({}));
    const result = await call(await connect(fake.fetch), 'get_openapi');

    expect(result.data).toMatchObject({ upstream_base: 'https://upstream.test/api/fx/2' });
    expect((result.data.tools as { name: string; available: boolean }[]).find((tool) => tool.name === 'search_posts')).toEqual({
      name: 'search_posts',
      endpoint: 'GET /2/search',
      available: false
    });
    expect(fake.urls).toHaveLength(0);
  });
});

describe('0.1 call shapes', () => {
  it('keeps every 0.1 argument shape working', async () => {
    const fake = fakeUpstream((url) => {
      if (url.pathname.endsWith('/search')) return json(searchUnavailable, 503);
      if (url.pathname.includes('/status/')) return json(status);
      if (url.pathname.endsWith('/trends')) return json(trends);
      if (url.pathname.endsWith('/typeahead')) return json(searchUnavailable, 503);
      if (url.pathname.endsWith('/statuses') || url.pathname.endsWith('/media')) return json(timelinePage());
      return json(profile);
    });
    const client = await connect(fake.fetch);

    const shapes: [string, Record<string, unknown> | undefined][] = [
      ['search_posts', { q: 'from:jack', feed: 'top', count: 100, cursor: 'DAAHCgAB' }],
      ['get_post', { id: '2000000000000000100' }],
      ['get_profile', { handle: '@jack' }],
      ['get_profile_statuses', { handle: 'jack', count: 100, cursor: '-1|2126233000214528001' }],
      ['get_profile_media', { handle: 'jack', count: 1 }],
      ['get_trends', { count: 100 }],
      ['typeahead', { q: 'jack', count: 5 }],
      ['get_openapi', {}],
      ['get_trends', undefined],
      ['get_openapi', undefined]
    ];
    for (const [name, args] of shapes) {
      const result = await call(client, name, args);
      expect(result.text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
      expect(result.text).not.toMatch(BRAND_RE);
      if (result.isError) expect(ErrorPayloadSchema.parse(result.data).code).toBe('feature_unavailable');
    }
  });
});
