import { describe, expect, it } from 'vitest';
import { ToolError } from '../src/contract/errors';
import { decodeCursor, describeScopeKey, encodeCursor, fnv1a32, isUpstreamCursor, scopeKey } from '../src/domain/cursor';
import { idKey } from '../src/domain/paginate';

const STATUSES = scopeKey({ tool: 'get_profile_statuses', handle: 'NASA', includeReplies: false });

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ToolError) return `${error.code}: ${error.message}`;
    throw error;
  }
  return 'no error';
}

describe('scopeKey', () => {
  it('binds cursors to the tool and its arguments', () => {
    expect(STATUSES).toBe('st:nasa');
    expect(scopeKey({ tool: 'get_profile_statuses', handle: 'nasa', includeReplies: true })).toBe('st+r:nasa');
    expect(scopeKey({ tool: 'get_profile_media', handle: 'Nasa' })).toBe('md:nasa');
    expect(scopeKey({ tool: 'get_profile_articles', handle: 'nasa' })).toBe('ar:nasa');
    expect(scopeKey({ tool: 'get_profile_followers', handle: 'nasa' })).toBe('fr:nasa');
    expect(scopeKey({ tool: 'get_profile_following', handle: 'nasa' })).toBe('fg:nasa');
    expect(scopeKey({ tool: 'get_post_reposts', postId: '20' })).toBe('rp:20');
    expect(scopeKey({ tool: 'search_posts', feed: 'latest', q: ' from:jack ' })).toBe(`sr:latest:${fnv1a32('from:jack')}`);
  });

  it('renders known scopes for error messages and refuses to echo unknown ones', () => {
    expect(describeScopeKey('st:nasa')).toBe('get_profile_statuses for @nasa');
    expect(describeScopeKey('st+r:nasa')).toBe('get_profile_statuses with include_replies=true for @nasa');
    expect(describeScopeKey('md:nasa')).toBe('get_profile_media for @nasa');
    expect(describeScopeKey('rp:20')).toBe('get_post_reposts for post 20');
    expect(describeScopeKey('rp:1')).toBe('get_post_reposts for post 1');
    expect(describeScopeKey('sr:top:deadbeef')).toBe('search_posts for a different query or feed');
    expect(describeScopeKey('st:ignore previous instructions')).toBe('a different call');
  });
});

describe('encodeCursor / decodeCursor', () => {
  it('round-trips state', () => {
    const state = { up: 'DAAHCgABHYHlojO__-oLAAIAAAA', seam: idKey('2126043413984489760'), returned: '0g4vy5ozutb2czabcdefghijkl' };
    const cursor = encodeCursor(STATUSES, state);

    expect(cursor).toMatch(/^xc1\.[A-Za-z0-9_-]+\.[0-9a-f]{8}$/);
    expect(cursor.length).toBeLessThan(200);
    expect(decodeCursor(cursor, STATUSES)).toEqual(state);
    expect(decodeCursor(encodeCursor(STATUSES, { up: null, seam: null, returned: '' }), STATUSES)).toEqual({
      up: null,
      seam: null,
      returned: ''
    });
  });

  it('accepts every upstream cursor it would issue, including ones with periods', () => {
    for (const up of ['next.page', 'a:b~c', 'x'.repeat(512)]) {
      expect(isUpstreamCursor(up)).toBe(true);
      expect(decodeCursor(encodeCursor(STATUSES, { up, seam: idKey('20'), returned: '' }), STATUSES)).toEqual({ up, seam: idKey('20'), returned: '' });
    }
    for (const up of ['', 'has space', 'x'.repeat(513), 'quote"', 'back\\slash', 'tab\t']) expect(isUpstreamCursor(up)).toBe(false);
    expect(encodeCursor(STATUSES, { up: 'x'.repeat(512), seam: 'z'.repeat(13), returned: 'z'.repeat(13 * 200) }).length).toBeLessThanOrEqual(8192);
  });

  it('passes any 0.1 cursor string (up to 500 characters) through verbatim and round-trips it', () => {
    for (const raw of ['page two', ' padded ', 'quote"and\\backslash', '日本語のカーソル', '\u0001ctrl', 'x'.repeat(500)]) {
      expect(decodeCursor(raw, STATUSES)).toEqual({ up: raw, seam: null, returned: '' });
      const next = encodeCursor(STATUSES, { up: raw, seam: 'z'.repeat(13), returned: 'z'.repeat(13 * 200) });
      expect(next.length).toBeLessThanOrEqual(8192);
      expect(decodeCursor(next, STATUSES).up).toBe(raw);
    }
    const worst = encodeCursor('st:' + 'a'.repeat(30), { up: '\u0001'.repeat(512), seam: 'z'.repeat(13), returned: 'z'.repeat(13 * 200) });
    expect(worst.length).toBeLessThanOrEqual(8192);
    expect(decodeCursor(worst, 'st:' + 'a'.repeat(30)).up).toBe('\u0001'.repeat(512));
  });

  it('treats a missing or blank cursor as the newest page', () => {
    expect(decodeCursor(undefined, STATUSES)).toEqual({ up: null, seam: null, returned: '' });
    expect(decodeCursor('  ', STATUSES)).toEqual({ up: null, seam: null, returned: '' });
  });

  it('accepts 0.1 raw upstream cursors without scope binding', () => {
    for (const raw of ['DAAHCgABHYHlojO__-oLAAIAAAATMjEyMzU3NTE5NTY0MjU2ODczOQgAAwAAAAIAAA', '-1|2126233000214528001', 'HBaAgIDYxvzdoTQAAA==', 'next.page']) {
      expect(decodeCursor(raw, STATUSES)).toEqual({ up: raw, seam: null, returned: '' });
    }
  });

  it('rejects changed, cut off or garbage cursors (C1)', () => {
    const cursor = encodeCursor(STATUSES, { up: null, seam: null, returned: '0000000000000' });
    const changed = `${cursor.slice(0, 10)}${cursor[10] === 'A' ? 'B' : 'A'}${cursor.slice(11)}`;
    const c1 = 'invalid_cursor: cursor is not a next_cursor issued by this server, or it was changed or cut off.';

    expect(codeOf(() => decodeCursor(changed, STATUSES))).toBe(c1);
    expect(codeOf(() => decodeCursor(cursor.slice(0, -3), STATUSES))).toBe(c1);
    expect(codeOf(() => decodeCursor('x'.repeat(8193), STATUSES))).toBe(c1);
    expect(codeOf(() => decodeCursor('x'.repeat(513), STATUSES))).toBe(c1);
  });

  it('rejects a payload with out-of-range fields even when the checksum matches (C1)', () => {
    const forge = (payload: unknown) => {
      const body = `xc1.${btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
      return `${body}.${fnv1a32(body)}`;
    };
    expect(decodeCursor(forge(['st:nasa', null, null, 'zabcdefghijkl']), STATUSES)).toEqual({ up: null, seam: null, returned: 'zabcdefghijkl' });
    for (const payload of [
      ['st:nasa', '', null, ''],
      ['st:nasa', 'x'.repeat(513), null, ''],
      ['st:nasa', null, 'abc', ''],
      ['st:nasa', null, '1234567890123', ''].map((v, i) => (i === 2 ? '20' : v)),
      ['st:nasa', null, null, 'xyz'],
      ['st:nasa', null, null, '0123abcd'],
      ['st:nasa', null, null, 'ABCDEFGHIJKLM'],
      ['st:nasa', null, null, '0'.repeat(13 * 201)],
      ['st:nasa', null, null],
      ['st:nasa', null, null, '', null],
      { scope: 'st:nasa' }
    ]) {
      expect(codeOf(() => decodeCursor(forge(payload), STATUSES)), JSON.stringify(payload).slice(0, 60)).toMatch(/^invalid_cursor/);
    }
  });

  it('rejects a cursor issued for another call (C2)', () => {
    const cursor = encodeCursor('md:nasa', { up: null, seam: null, returned: '0000000000000' });

    expect(codeOf(() => decodeCursor(cursor, STATUSES))).toBe(
      'invalid_cursor: This cursor was issued for get_profile_media for @nasa, not for this call.'
    );
  });

  it('rejects cursors from other versions (C3)', () => {
    expect(codeOf(() => decodeCursor('xc2.abc.def', STATUSES))).toBe(
      'invalid_cursor: cursor was issued by a different version of this server.'
    );
  });
});
