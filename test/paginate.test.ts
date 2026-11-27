import { describe, expect, it } from 'vitest';
import type { CursorState } from '../src/domain/cursor';
import { paginate, resumeIndex, type Page } from '../src/domain/paginate';

type Item = { id: string; text?: string };

/**
 * A fake upstream timeline (newest first) with cursor-based pages, like the real proxy:
 * - a page is `pageSize` items after the item named by the cursor (null = newest)
 * - bottom is always a fresh, non-null cursor, even on the empty end page
 */
class FakeTimeline {
  items: Item[];
  fetches = 0;
  overlap = false;

  constructor(
    count: number,
    readonly pageSize = 5
  ) {
    this.items = Array.from({ length: count }, (_, i) => ({ id: String(1000 + count - i) }));
  }

  fetchPage = async (up: string | null): Promise<Page> => {
    this.fetches++;
    let start = 0;
    if (up !== null) {
      const index = this.items.findIndex((item) => item.id === up.replace(/^after-/, ''));
      start = index === -1 ? this.items.length : this.overlap ? index : index + 1;
    }
    const items = this.items.slice(start, start + this.pageSize);
    const last = items.at(-1);
    return { items, bottom: last ? `after-${last.id}` : `after-end-${this.fetches}` };
  };
}

const project = (item: unknown) => ({ id: (item as Item).id, text: (item as Item).text });

async function drain(timeline: FakeTimeline, count: number, between?: (call: number) => void) {
  const seen: string[] = [];
  let state: CursorState = { up: null, off: 0, anc: null, seam: null };
  const fetchesPerCall: number[] = [];
  for (let call = 0; call < 200; call++) {
    const before = timeline.fetches;
    const result = await paginate({ state, count, fetchPage: timeline.fetchPage, project });
    fetchesPerCall.push(timeline.fetches - before);
    seen.push(...result.items.map((item) => item.id));
    if (!result.hasMore || result.next === undefined) return { seen, fetchesPerCall, last: result };
    state = result.next;
    between?.(call);
  }
  throw new Error('drain did not terminate');
}

describe('resumeIndex', () => {
  const items = [{ id: '5' }, { id: '4' }, { id: '3' }, { id: '2' }, { id: '1' }];

  it('uses the offset when there is no anchor', () => {
    expect(resumeIndex(items, 2, null)).toEqual({ start: 2, shifted: false });
    expect(resumeIndex(items, 9, null)).toEqual({ start: 5, shifted: false });
  });

  it('continues after the anchor when the page is unchanged or shifted', () => {
    expect(resumeIndex(items, 2, '4')).toEqual({ start: 2, shifted: false });
    expect(resumeIndex(items, 1, '4')).toEqual({ start: 2, shifted: false });
  });

  it('starts a fresh page from the top (a repeated anchor is skipped as already seen, not as a seam)', () => {
    expect(resumeIndex(items, 0, '5')).toEqual({ start: 0, shifted: false });
    expect(resumeIndex(items, 0, '1')).toEqual({ start: 0, shifted: false });
  });

  it('falls back to off - 1 when the anchor disappeared', () => {
    expect(resumeIndex(items, 3, '99')).toEqual({ start: 2, shifted: true });
  });
});

describe('paginate', () => {
  it.each([1, 3, 7, 10, 20, 100])('drains a 3-page timeline at count %i without skips or duplicates', async (count) => {
    const timeline = new FakeTimeline(13);
    const { seen, fetchesPerCall } = await drain(timeline, count);

    expect(seen).toEqual(timeline.items.map((item) => item.id));
    expect(Math.max(...fetchesPerCall)).toBeLessThanOrEqual(2);
  });

  it('reads exactly one upstream page per call in a normal drain', async () => {
    const timeline = new FakeTimeline(20, 5);
    const { fetchesPerCall } = await drain(timeline, 5);

    // The last call reads the empty end page.
    expect(fetchesPerCall.every((n) => n === 1)).toBe(true);
  });

  it('enforces count even though the upstream page is larger', async () => {
    const timeline = new FakeTimeline(30, 20);
    const result = await paginate({ state: { up: null, off: 0, anc: null, seam: null }, count: 2, fetchPage: timeline.fetchPage, project });

    expect(result.items.map((item) => item.id)).toEqual(['1030', '1029']);
    expect(result).toMatchObject({ hasMore: true, next: { up: null, off: 2, anc: '1029' }, truncated: false });
  });

  it('reports a short page when the upstream page ends before count', async () => {
    const timeline = new FakeTimeline(30, 20);
    const result = await paginate({ state: { up: null, off: 0, anc: null, seam: null }, count: 50, fetchPage: timeline.fetchPage, project });

    expect(result.items).toHaveLength(20);
    expect(result).toMatchObject({ hasMore: true, pageEnded: true, next: { up: 'after-1011', off: 0, anc: '1011' } });
  });

  it('ends on an empty page even though the upstream still returns a fresh bottom cursor', async () => {
    const timeline = new FakeTimeline(5, 5);
    const first = await paginate({ state: { up: null, off: 0, anc: null, seam: null }, count: 5, fetchPage: timeline.fetchPage, project });
    const second = await paginate({ state: first.next!, count: 5, fetchPage: timeline.fetchPage, project });

    expect(first.hasMore).toBe(true);
    expect(second).toMatchObject({ items: [], hasMore: false, endOfList: true, firstPageEmpty: false });
  });

  it('flags an empty first page so callers can diagnose the account', async () => {
    const timeline = new FakeTimeline(0);
    const result = await paginate({ state: { up: null, off: 0, anc: null, seam: null }, count: 5, fetchPage: timeline.fetchPage, project });

    expect(result).toMatchObject({ items: [], hasMore: false, firstPageEmpty: true });
  });

  it('skips the item repeated at a page seam', async () => {
    const timeline = new FakeTimeline(13);
    timeline.overlap = true;

    const { seen } = await drain(timeline, 5);
    expect(seen).toEqual(timeline.items.map((item) => item.id));
  });

  it('does not skip unread items placed before a repeated anchor on the next page', async () => {
    const pages: Record<string, Page> = {
      start: { items: [{ id: '91' }, { id: '89' }], bottom: 'p2' },
      p2: { items: [{ id: '88' }, { id: '89' }, { id: '87' }], bottom: 'p3' },
      p3: { items: [], bottom: 'p4' }
    };
    const fetchPage = async (up: string | null) => pages[up ?? 'start']!;
    const seen: string[] = [];
    let state: CursorState = { up: null, off: 0, anc: null, seam: null };
    for (let call = 0; call < 10; call++) {
      const result = await paginate({ state, count: 2, fetchPage, project });
      seen.push(...result.items.map((item) => item.id));
      if (!result.hasMore) break;
      state = result.next!;
    }
    expect(seen).toEqual(['91', '89', '88', '87']);
  });

  it('remembers the previous page anchor until the next page is used up', async () => {
    const pages: Record<string, Page> = {
      start: { items: [{ id: '91' }, { id: '89' }], bottom: 'p2' },
      p2: { items: [{ id: '88' }, { id: '87' }, { id: '89' }, { id: '86' }], bottom: 'p3' },
      p3: { items: [], bottom: 'p4' }
    };
    const fetchPage = async (up: string | null) => pages[up ?? 'start']!;
    const seen: string[] = [];
    let state: CursorState = { up: null, off: 0, anc: null, seam: null };
    for (let call = 0; call < 10; call++) {
      const result = await paginate({ state, count: 1, fetchPage, project });
      seen.push(...result.items.map((item) => item.id));
      if (!result.hasMore) break;
      state = result.next!;
    }
    expect(seen).toEqual(['91', '89', '88', '87', '86']);
  });

  it('keeps the in-page anchor on the last returned item when it skips the previous page anchor', async () => {
    let p2 = [{ id: '88' }, { id: '87' }, { id: '89' }, { id: '86' }, { id: '89' }];
    const fetchPage = async (up: string | null): Promise<Page> =>
      up === 'p2' ? { items: p2, bottom: 'p3' } : up === 'p3' ? { items: [], bottom: 'p4' } : { items: [{ id: '91' }, { id: '89' }], bottom: 'p2' };
    const seen: string[] = [];
    let state: CursorState = { up: null, off: 0, anc: null, seam: null };
    for (let call = 0; call < 12; call++) {
      const result = await paginate({ state, count: 1, fetchPage, project });
      seen.push(...result.items.map((item) => item.id));
      // After 87 is returned, the first (seam) 89 disappears from the page.
      if (result.items[0]?.id === '87') p2 = [{ id: '88' }, { id: '87' }, { id: '86' }, { id: '89' }];
      if (!result.hasMore) break;
      state = result.next!;
    }
    expect(seen).toEqual(['91', '89', '88', '87', '86']);
  });

  it('never returns an item twice when the upstream repeats it on the same page', async () => {
    const timeline = new FakeTimeline(6, 6);
    timeline.items.splice(3, 0, { id: timeline.items[1]!.id });

    const { seen } = await drain(timeline, 2);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(6);
  });

  it('stays lossless when new posts arrive at the top between calls', async () => {
    const timeline = new FakeTimeline(13);
    const original = timeline.items.map((item) => item.id);
    let next = 5000;

    const { seen } = await drain(timeline, 3, () => {
      timeline.items.unshift({ id: String(next++) }, { id: String(next++) });
    });
    expect(seen).toEqual(original);
  });

  it('falls back to the offset when the anchor post is deleted between calls', async () => {
    const timeline = new FakeTimeline(13);
    const first = await paginate({ state: { up: null, off: 0, anc: null, seam: null }, count: 2, fetchPage: timeline.fetchPage, project });
    timeline.items = timeline.items.filter((item) => item.id !== first.next!.anc);

    const second = await paginate({ state: first.next!, count: 2, fetchPage: timeline.fetchPage, project });
    expect(second.shifted).toBe(true);
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(['1013', '1012', '1011', '1010']);
  });

  it('hops to the next page once when nothing on the current page is left to return', async () => {
    const ids = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => ({ id: String(from - i) }));
    let shrunk = false;
    const requested: (string | null)[] = [];
    const fetchPage = async (up: string | null): Promise<Page> => {
      requested.push(up);
      if (up === null) return shrunk ? { items: ids(1010, 1007), bottom: 'after-1007' } : { items: ids(1010, 1006), bottom: 'after-1006' };
      return { items: ids(1005, 1001), bottom: 'after-1001' };
    };

    const first = await paginate({ state: { up: null, off: 0, anc: null, seam: null }, count: 4, fetchPage, project });
    // The newest page shrank: 1006 is gone and the page now ends right at the anchor.
    shrunk = true;
    requested.length = 0;
    const second = await paginate({ state: first.next!, count: 4, fetchPage, project });

    expect(requested).toEqual([null, 'after-1007']);
    expect(second.items.map((item) => item.id)).toEqual(['1005', '1004', '1003', '1002']);
    expect(second.next).toEqual({ up: 'after-1007', off: 4, anc: '1002', seam: '1007' });
  });

  it('ends the list instead of looping when the upstream stops advancing', async () => {
    const stuck = async (): Promise<Page> => ({ items: [{ id: '1001' }], bottom: 'same' });
    const result = await paginate({ state: { up: 'same', off: 0, anc: '1001', seam: '1001' }, count: 5, fetchPage: stuck, project });

    expect(result).toMatchObject({ items: [], hasMore: false, endOfList: true });
  });

  it('stops at the character budget, returns at least one item and continues losslessly', async () => {
    const timeline = new FakeTimeline(6, 6);
    for (const item of timeline.items) item.text = 'x'.repeat(400);
    const budget = 1_000;

    const first = await paginate({ state: { up: null, off: 0, anc: null, seam: null }, count: 6, fetchPage: timeline.fetchPage, project, budget });
    expect(first.truncated).toBe(true);
    expect(first.items).toHaveLength(2);

    const seen = first.items.map((item) => item.id);
    let state = first.next!;
    for (;;) {
      const result = await paginate({ state, count: 6, fetchPage: timeline.fetchPage, project, budget: 10 });
      expect(result.items.length).toBeGreaterThanOrEqual(result.hasMore ? 1 : 0);
      seen.push(...result.items.map((item) => item.id));
      if (!result.hasMore) break;
      state = result.next!;
    }
    expect(seen).toEqual(timeline.items.map((item) => item.id));
  });
});
