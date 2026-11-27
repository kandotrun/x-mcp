import { describe, expect, it } from 'vitest';
import { cleanText, cut, echo } from '../src/domain/text';
import { parseHandleRef, parsePostRef } from '../src/domain/normalize';
import { ToolError } from '../src/contract/errors';

function errorOf(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error('expected a ToolError');
}

describe('cleanText', () => {
  it('normalizes full-width input and strips invisible characters and wrapping punctuation', () => {
    expect(cleanText('＠ｊａｃｋ')).toBe('@jack');
    expect(cleanText('２０')).toBe('20');
    expect(cleanText('​jack﻿')).toBe('jack');
    expect(cleanText('  <https://x.com/jack/status/20>. ')).toBe('https://x.com/jack/status/20');
    expect(cleanText('「jack」')).toBe('jack');
    expect(cleanText('ja\u0000ck')).toBe('ja ck');
  });
});

describe('cut', () => {
  it('counts code points and marks truncation', () => {
    expect(cut('abc', 5)).toEqual({ text: 'abc' });
    expect(cut('😀😀😀', 2)).toEqual({ text: '😀😀…', truncated: true });
    expect(cut('日本語テキスト', 3)).toEqual({ text: '日本語…', truncated: true });
  });
});

describe('echo', () => {
  it('collapses whitespace, strips control characters and caps the length at 80', () => {
    expect(echo('a\n\tb')).toBe('a b');
    expect(echo('x'.repeat(100))).toHaveLength(80);
  });

  it('drops invisible, bidi and C1 control characters', () => {
    expect(echo('\u202Etsop\u202C ab\u200Bcd\u2066x\u2069 abc\u009B31m\u0085next')).toBe('tsop abcdx abc 31m next');
  });
});

describe('parsePostRef', () => {
  it.each([
    ['1', '1'],
    ['20', '20'],
    [' 20 ', '20'],
    ['123456789012345678901234567890', '123456789012345678901234567890'],
    ['２１２６０４３４１３９８４４８９７６９', '2126043413984489769'],
    ['https://x.com/jack/status/20', '20'],
    ['x.com/jack/status/20?s=20&t=abc', '20'],
    ['https://twitter.com/jack/status/20/photo/1', '20'],
    ['https://mobile.twitter.com/jack/status/20', '20'],
    ['https://x.com/i/web/status/20', '20'],
    ['https://x.com/i/status/20', '20'],
    ['https://twitter.com/jack/statuses/20', '20'],
    ['https://vxtwitter.com/jack/status/20', '20'],
    ['//x.com/jack/status/20', '20'],
    ['https://x.com/@jack/status/20#m', '20']
  ])('accepts %s', (input, expected) => {
    expect(parsePostRef(input)).toBe(expected);
  });

  it.each([
    ['1234567890123456789012345678901', `'1234567890123456789012345678901' is not a post ID or post URL.`],
    ['', `'' is not a post ID or post URL.`],
    ['javascript:alert(1)', `'javascript:alert(1)' is not a post ID or post URL.`],
    ['https://example.com/hello', `'https://example.com/hello' is not a post ID or post URL.`]
  ])('rejects %s as invalid_argument (V1)', (input, message) => {
    const error = errorOf(() => parsePostRef(input));
    expect(error.code).toBe('invalid_argument');
    expect(error.message).toBe(message);
    expect(error.retryable).toBe(false);
  });

  it('explains t.co links (V2)', () => {
    expect(errorOf(() => parsePostRef('https://t.co/abc123')).message).toBe(
      't.co short links cannot be expanded by this server.'
    );
  });

  it('points profile links to the profile tools (V3)', () => {
    const error = errorOf(() => parsePostRef('https://x.com/nasa'));
    expect(error.message).toBe(`'https://x.com/nasa' is a profile link (@nasa), not a post link.`);
    expect(error.hint).toBe('For the account call get_profile or get_profile_statuses with {"handle":"nasa"}.');
  });

  it('explains Article links (V4)', () => {
    expect(errorOf(() => parsePostRef('https://x.com/i/article/2099495152490323968')).message).toBe(
      `'https://x.com/i/article/2099495152490323968' is an X Article link; its ID is not a post ID.`
    );
  });
});

describe('parseHandleRef', () => {
  it.each([
    ['jack', 'jack'],
    ['@jack', 'jack'],
    [' @@jack ', 'jack'],
    ['＠ｊａｃｋ', 'jack'],
    ['NASA', 'NASA'],
    ['12345', '12345'],
    ['a_very_long_historical_name_29', 'a_very_long_historical_name_29'],
    ['https://x.com/nasa', 'nasa'],
    ['x.com/nasa/media', 'nasa'],
    ['https://twitter.com/NASA?lang=en', 'NASA'],
    ['https://mobile.twitter.com/@nasa/with_replies', 'nasa'],
    ['https://x.com/jack/status/20', 'jack']
  ])('accepts %s', (input, expected) => {
    expect(parseHandleRef(input)).toBe(expected);
  });

  it.each([
    ['id:12', 'V6'],
    ['1234567890123456789', 'V6'],
    ['https://netflix.com/browse', 'V7'],
    ['https://x.com/i/status/20', 'V8'],
    ['https://x.com/i/web/status/20', 'V8'],
    ['https://x.com/home', 'V5'],
    ['https://x.com/search?q=x', 'V5'],
    ['not a handle!', 'V5'],
    ['', 'V5']
  ])('rejects %s (%s)', (input, kind) => {
    const error = errorOf(() => parseHandleRef(input));
    expect(error.code).toBe('invalid_argument');
    const expected = {
      V5: `'${input.trim()}' is not an X handle or profile link.`,
      V6: `'${input}' looks like a numeric ID; numeric account IDs are not supported.`,
      V7: `'netflix.com' is not an x.com or twitter.com link.`,
      V8: 'This post link has no account name in it.'
    }[kind];
    expect(error.message).toBe(expected);
  });

  it('suggests get_post for long numeric strings that look like post IDs', () => {
    expect(errorOf(() => parseHandleRef('1234567890123456789')).hint).toBe(
      'Pass the @handle, e.g. {"handle":"nasa"}. For a post ID call get_post with {"id":"1234567890123456789"}.'
    );
    expect(errorOf(() => parseHandleRef('id:12')).hint).toBe('Pass the @handle, e.g. {"handle":"nasa"}.');
    expect(errorOf(() => parseHandleRef('9'.repeat(40))).hint).toBe('Pass the @handle, e.g. {"handle":"nasa"}.');
  });

  it('keeps caller text out of JSON examples in hints', () => {
    const hint = errorOf(() => parseHandleRef('x.com/i/status/1"x')).hint;
    expect(hint).toBe('Call get_post with this link as id and read post.author.handle.');
  });
});
