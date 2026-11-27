import { describe, expect, it } from 'vitest';
import { PostSchema, TrendSchema, TypeaheadUserSchema, UnavailableSchema, UserSchema } from '../src/contract/envelopes';
import {
  articleText,
  isoTime,
  projectPost,
  projectTrend,
  projectTypeaheadUser,
  projectUser,
  stripMosaic
} from '../src/domain/project';
import articles from './fixtures/articles.json';
import profile from './fixtures/profile.json';
import status from './fixtures/status.json';
import statuses from './fixtures/statuses.json';
import trends from './fixtures/trends.json';
import typeahead from './fixtures/typeahead.json';
import users from './fixtures/users.json';

describe('isoTime', () => {
  it('converts upstream timestamps and dates to ISO-8601 UTC without milliseconds', () => {
    expect(isoTime(1795723224, undefined)).toBe('2026-11-26T20:00:24Z');
    expect(isoTime(1795723224000, undefined)).toBe('2026-11-26T20:00:24Z');
    expect(isoTime(undefined, 'Mon Jan 02 03:04:05 +0000 2012')).toBe('2012-01-02T03:04:05Z');
    expect(isoTime(undefined, 'not a date')).toBe('not a date');
    expect(isoTime(undefined, undefined)).toBeUndefined();
  });
});

describe('projectPost', () => {
  it('projects a rich post into the concise contract', () => {
    const post = projectPost(status.status, 'single');

    expect(PostSchema.parse(post)).toEqual(post);
    expect(post).toEqual({
      id: '2000000000000000100',
      url: 'https://x.com/example_dev/status/2000000000000000100',
      created_at: '2026-11-26T20:00:24Z',
      author: { handle: 'example_dev', name: 'Example Dev', verified: true },
      text: 'Shipping a tiny MCP server today. Poll below!',
      lang: 'en',
      metrics: { replies: 12, reposts: 34, quotes: 3, likes: 567, bookmarks: 8, views: 12345 },
      quote: {
        id: '2000000000000000050',
        url: 'https://x.com/sample_news/status/2000000000000000050',
        author: 'sample_news',
        created_at: '2026-11-26T20:00:24Z',
        text: 'Quoted post about samples.'
      },
      media: [
        { type: 'photo', url: 'https://pbs.twimg.com/media/EXAMPLEPHOTO.jpg?name=orig', alt: 'A whiteboard sketch' },
        {
          type: 'video',
          url: 'https://video.twimg.com/amplify_video/2000000000000000102/vid/avc1/1280x720/EXAMPLE.mp4?tag=16',
          thumbnail_url: 'https://pbs.twimg.com/media/EXAMPLETHUMB.jpg',
          duration_s: 17.7
        }
      ],
      poll: {
        choices: [
          { label: 'Yes', votes: 30, percent: 75 },
          { label: 'No', votes: 10, percent: 25 }
        ],
        total_votes: 40,
        ends_at: '2026-11-28T20:00:24Z'
      },
      community_note: 'Context: this is a fictional example.'
    });
    expect(Object.keys(post)).toEqual([
      'id',
      'url',
      'created_at',
      'author',
      'text',
      'lang',
      'metrics',
      'quote',
      'media',
      'poll',
      'community_note'
    ]);
  });

  it('keeps reposts, replies and tombstoned quotes readable in timelines', () => {
    const [plain, repost, reply] = statuses.results.map((item) => projectPost(item, 'list'));

    expect(plain).toMatchObject({ id: '2000000000000000203', text: 'Plain post number three.' });
    expect(repost).toMatchObject({ author: { handle: 'sample_news' }, reposted_by: 'example_dev' });
    expect(reply).toMatchObject({
      reply_to: { handle: 'sample_news', post_id: '2000000000000000050' },
      quote: { id: '2000000000000000040', url: 'https://x.com/i/status/2000000000000000040', unavailable: 'deleted' }
    });
    for (const item of [plain, repost, reply]) expect(PostSchema.parse(item)).toEqual(item);
  });

  it('cuts long list text by code points and marks it', () => {
    const long = { ...statuses.results[0], text: `${'あ'.repeat(999)}😀😀` };

    expect(projectPost(long, 'list')).toMatchObject({ text: `${'あ'.repeat(999)}😀…`, text_truncated: true });
    expect(projectPost(long, 'single')).toMatchObject({ text: long.text });
  });

  it('turns unavailable list entries into tombstones', () => {
    const tombstone = { type: 'tombstone', reason: 'suspended', id: '2000000000000000041', url: 'https://x.com/i/status/1' };

    expect(UnavailableSchema.parse(projectPost(tombstone, 'list'))).toEqual({
      id: '2000000000000000041',
      url: 'https://x.com/i/status/1',
      unavailable: 'suspended'
    });
    expect(projectPost(null, 'list')).toEqual({ unavailable: 'unavailable' });
  });

  it('includes Article text only for single posts', () => {
    const raw = articles.results[0];

    expect(projectPost(raw, 'list')).toMatchObject({
      article: { title: 'Notes on tiny servers', preview_text: 'Small servers are easier to reason about.' }
    });
    expect(projectPost(raw, 'list')).not.toHaveProperty('article.text');
    expect(projectPost(raw, 'single')).toMatchObject({ article: { text: 'Small servers are easier to reason about.' } });
  });

  it('never throws on unexpected shapes', () => {
    for (const raw of [undefined, 42, 'text', [], { id: 5 }, { type: 'status', media: 'x', quote: 7, poll: { choices: 'no' } }]) {
      expect(() => projectPost(raw, 'list')).not.toThrow();
    }
  });
});

describe('articleText', () => {
  it('renders Draft.js blocks as plain text with Markdown-like prefixes', () => {
    expect(
      articleText({
        blocks: [
          { type: 'header-one', text: 'Title' },
          { type: 'unstyled', text: 'Intro' },
          { type: 'unordered-list-item', text: 'one' },
          { type: 'ordered-list-item', text: 'two' },
          { type: 'blockquote', text: 'quote' },
          { type: 'atomic', text: ' ' },
          { type: 'unstyled', text: '   ' }
        ]
      })
    ).toBe('# Title\n\nIntro\n\n- one\n\n1. two\n\n> quote');
  });

  it('keeps the text of blocks whose type is not a string, without throwing', () => {
    expect(articleText({ blocks: [{ type: { toString: null }, text: 'body' }, { type: 7, text: 'more' }] })).toBe('body\n\nmore');
    // Only the block types defined in the prefix table get a prefix, not inherited object keys.
    expect(articleText({ blocks: [{ type: 'toString', text: 'one' }, { type: 'constructor', text: 'two' }, { type: 'header-one', text: 'Title' }] })).toBe(
      'one\n\ntwo\n\n# Title'
    );
  });
});

describe('projectUser', () => {
  it('projects a profile into the concise contract', () => {
    const user = projectUser(profile.user);

    expect(UserSchema.parse(user)).toEqual(user);
    expect(user).toEqual({
      handle: 'example_dev',
      name: 'Example Dev',
      id: '1000000001',
      url: 'https://x.com/example_dev',
      description: 'Builds small tools.',
      location: 'Internet',
      website: 'https://example.com',
      joined: '2012-01-02T03:04:05Z',
      followers: 98765,
      following: 321,
      posts: 2345,
      likes: 4567,
      media_count: 89,
      verified: true,
      verified_type: 'individual'
    });
  });

  it('adds About this account data only when asked', () => {
    const raw = {
      ...profile.user,
      about_account: {
        based_in: 'Japan',
        location_accurate: false,
        created_country_accurate: true,
        source: 'Japan App Store',
        username_changes: { count: 1, last_changed_at: '2020-01-01T00:00:00.000Z' }
      }
    };

    expect(projectUser(raw)).not.toHaveProperty('about');
    expect(projectUser(raw, { includeAbout: true }).about).toEqual({
      based_in: 'Japan',
      location_accurate: false,
      created_country_accurate: true,
      source: 'Japan App Store',
      username_changes: 1,
      username_last_changed_at: '2020-01-01T00:00:00Z'
    });
  });

  it('marks protected accounts and keeps zero counters', () => {
    const user = projectUser({ ...profile.user, protected: true, followers: 0 });
    expect(user).toMatchObject({ protected: true, followers: 0 });
  });

  it('projects list users', () => {
    for (const raw of users.results) {
      const user = projectUser(raw);
      expect(UserSchema.parse(user)).toEqual(user);
    }
  });
});

describe('typeahead and trends', () => {
  it('projects typeahead users and trends', () => {
    expect(TypeaheadUserSchema.parse(projectTypeaheadUser(typeahead.users[0]))).toEqual({
      handle: 'example_dev',
      name: 'Example Dev',
      verified: true,
      followers: 98765
    });
    expect(trends.trends.map(projectTrend).map((trend) => TrendSchema.parse(trend))).toEqual([
      { name: '#ExampleTrend', context: 'Technology · Trending', rank: 1 },
      { name: 'Sample Topic', context: 'Trending in Japan', rank: 2 },
      { name: 'Third Trend', context: 'Sports · Trending', rank: 3 }
    ]);
  });
});

describe('stripMosaic', () => {
  it('removes every mosaic key, including nested ones, without touching anything else', () => {
    const stripped = stripMosaic(status.status) as { media: Record<string, unknown> };

    expect(JSON.stringify(stripped)).not.toContain('mosaic');
    expect(Object.keys(stripped.media)).toEqual(['all', 'photos', 'videos']);
    expect(JSON.stringify(status.status)).toContain('mosaic');
  });
});
