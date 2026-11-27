import { describe, expect, it } from 'vitest';
import type { CursorState } from '../src/domain/cursor';
import { ToolError } from '../src/contract/errors';
import { idKey, paginate, type Page } from '../src/domain/paginate';

type Item = { id: string; text?: string };

const START: CursorState = { up: null, seam: null, returned: '' };
const project = (item: unknown) => ({ id: (item as Item).id, text: (item as Item).text });
const prints = (...ids: string[]) => ids.map(idKey).join('');

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

async function drain(fetchPage: (up: string | null) => Promise<Page>, count: number, between?: (seen: string[]) => void) {
  const seen: string[] = [];
  let state = START;
  for (let call = 0; call < 300; call++) {
    const result = await paginate({ state, count, fetchPage, project });
    seen.push(...result.items.map((item) => item.id));
    if (!result.hasMore || result.next === undefined) return seen;
    state = result.next;
    between?.(seen);
  }
  throw new Error('drain did not terminate');
}

/** mulberry32: a small seeded PRNG, so failures are reproducible. */
function prng(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pagedFetch = (pages: string[][]) => async (up: string | null): Promise<Page> => {
  const index = up === null ? 0 : Number(up.slice(1));
  return { items: (pages[index] ?? []).map((id) => ({ id })), bottom: `p${index + 1}` };
};

describe('paginate', () => {
  it.each([1, 3, 7, 10, 20, 100])('drains a 3-page timeline at count %i without skips or duplicates', async (count) => {
    const timeline = new FakeTimeline(13);
    expect(await drain(timeline.fetchPage, count)).toEqual(timeline.items.map((item) => item.id));
  });

  it('reads exactly one upstream page per call in a normal drain', async () => {
    const timeline = new FakeTimeline(20, 5);
    const counts: number[] = [];
    let state = START;
    for (;;) {
      const before = timeline.fetches;
      const result = await paginate({ state, count: 5, fetchPage: timeline.fetchPage, project });
      counts.push(timeline.fetches - before);
      if (!result.hasMore) break;
      state = result.next!;
    }
    expect(counts.every((n) => n === 1)).toBe(true);
  });

  it('enforces count even though the upstream page is larger and remembers what it returned', async () => {
    const timeline = new FakeTimeline(30, 20);
    const result = await paginate({ state: START, count: 2, fetchPage: timeline.fetchPage, project });

    expect(result.items.map((item) => item.id)).toEqual(['1030', '1029']);
    expect(result).toMatchObject({ hasMore: true, next: { up: null, seam: null, returned: prints('1030', '1029') }, truncated: false });
  });

  it('reports a short page when the upstream page ends before count', async () => {
    const timeline = new FakeTimeline(30, 20);
    const result = await paginate({ state: START, count: 50, fetchPage: timeline.fetchPage, project });

    expect(result.items).toHaveLength(20);
    expect(result).toMatchObject({ hasMore: true, pageEnded: true, next: { up: 'after-1011', seam: '1011', returned: '' } });
  });

  it('ends on an empty page even though the upstream still returns a fresh bottom cursor', async () => {
    const timeline = new FakeTimeline(5, 5);
    const first = await paginate({ state: START, count: 5, fetchPage: timeline.fetchPage, project });
    const second = await paginate({ state: first.next!, count: 5, fetchPage: timeline.fetchPage, project });

    expect(first.hasMore).toBe(true);
    expect(second).toMatchObject({ items: [], hasMore: false, endOfList: true, firstPageEmpty: false });
  });

  it('flags an empty first page so callers can diagnose the account', async () => {
    const result = await paginate({ state: START, count: 5, fetchPage: new FakeTimeline(0).fetchPage, project });
    expect(result).toMatchObject({ items: [], hasMore: false, firstPageEmpty: true });
  });

  it('skips the item repeated at a page seam', async () => {
    const timeline = new FakeTimeline(13);
    timeline.overlap = true;
    expect(await drain(timeline.fetchPage, 5)).toEqual(timeline.items.map((item) => item.id));
  });

  it('never returns an item twice when the upstream repeats it on the same page', async () => {
    const timeline = new FakeTimeline(6, 6);
    timeline.items.splice(3, 0, { id: timeline.items[1]!.id });

    const seen = await drain(timeline.fetchPage, 2);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(6);
  });

  it('returns posts added at the top in a later call and never repeats or skips the rest', async () => {
    const timeline = new FakeTimeline(13);
    const original = timeline.items.map((item) => item.id);
    let next = 5000;

    const seen = await drain(timeline.fetchPage, 3, () => {
      timeline.items.unshift({ id: String(next++) }, { id: String(next++) });
    });
    expect(seen.filter((id) => original.includes(id))).toEqual(original);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('stays lossless when the last returned post is deleted between calls', async () => {
    const timeline = new FakeTimeline(13);
    const first = await paginate({ state: START, count: 2, fetchPage: timeline.fetchPage, project });
    timeline.items = timeline.items.filter((item) => item.id !== '1012');

    const second = await paginate({ state: first.next!, count: 2, fetchPage: timeline.fetchPage, project });
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

    const first = await paginate({ state: START, count: 4, fetchPage, project });
    // The newest page shrank: 1006 is gone and every remaining item was already returned.
    shrunk = true;
    requested.length = 0;
    const second = await paginate({ state: first.next!, count: 4, fetchPage, project });

    expect(requested).toEqual([null, 'after-1007']);
    expect(second.items.map((item) => item.id)).toEqual(['1005', '1004', '1003', '1002']);
    expect(second.next).toEqual({ up: 'after-1007', seam: '1007', returned: prints('1005', '1004', '1003', '1002') });
  });

  it('ends the list instead of looping when the upstream stops advancing', async () => {
    const stuck = async (): Promise<Page> => ({ items: [{ id: '1001' }], bottom: 'same' });
    const result = await paginate({ state: { up: 'same', seam: '1001', returned: '' }, count: 5, fetchPage: stuck, project });

    expect(result).toMatchObject({ items: [], hasMore: false, endOfList: true });
  });

  it('stops at the character budget, returns at least one item and continues losslessly', async () => {
    const timeline = new FakeTimeline(6, 6);
    for (const item of timeline.items) item.text = 'x'.repeat(400);

    const first = await paginate({ state: START, count: 6, fetchPage: timeline.fetchPage, project, budget: 1_000 });
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

  // Cases found in review: repeated ids around page seams and duplicates inside a page.
  it.each([
    ['a repeated anchor after unread items', [['91', '89'], ['88', '89', '87']], 2, ['91', '89', '88', '87']],
    ['the previous page anchor later on the next page', [['91', '89'], ['88', '87', '89', '86']], 1, ['91', '89', '88', '87', '86']],
    ['skipped duplicates on an unchanged page', [['91', '89', '87', '91', '89', '86', '87']], 3, ['91', '89', '87', '86']],
    ['pages that hold only duplicates', [['1000', '1001'], ['1001', '1001'], ['1001'], ['1001', '1004']], 2, ['1000', '1001', '1004']]
  ])('drains %s', async (_name, pages, count, expected) => {
    expect(await drain(pagedFetch(pages), count)).toEqual(expected);
  });

  it('records entries without a numeric id, so they are returned once and the page moves on', async () => {
    const tombstone = { type: 'tombstone', reason: 'deleted' };
    const fetchPage = async (up: string | null): Promise<Page> =>
      up === null ? { items: [tombstone, { id: '1001' }, tombstone], bottom: 'p2' } : { items: [], bottom: 'p3' };
    const seen: unknown[] = [];
    let state = START;
    for (let call = 0; call < 10; call++) {
      const result = await paginate({ state, count: 1, fetchPage, project: (item: unknown) => item });
      seen.push(...result.items);
      if (!result.hasMore) break;
      state = result.next!;
    }
    expect(seen).toEqual([tombstone, { id: '1001' }]);
  });

  it('keeps exact ids, so distinct ids never collide', async () => {
    // These two ids share an FNV-1a 32-bit hash.
    expect(await drain(pagedFetch([['2000000000001522232', '2000000000000412299']]), 1)).toEqual([
      '2000000000001522232',
      '2000000000000412299'
    ]);
  });

  it('reads a page larger than a cursor can track when few calls are needed, and refuses to cycle otherwise', async () => {
    const ids = Array.from({ length: 202 }, (_, i) => String(10_000 + i));
    expect(await drain(pagedFetch([ids]), 100)).toEqual(ids);

    const error = await drain(pagedFetch([ids]), 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code: 'upstream_unavailable', retryable: false });
  });

  it('stays lossless when a duplicated post loses one of its entries between calls', async () => {
    let p2 = ['88', '87', '89', '86', '89'];
    const fetchPage = async (up: string | null): Promise<Page> => {
      const ids = up === null ? ['91', '89'] : up === 'p2' ? p2 : [];
      return { items: ids.map((id) => ({ id })), bottom: up === null ? 'p2' : up === 'p2' ? 'p3' : 'p4' };
    };
    const seen = await drain(fetchPage, 1, (soFar) => {
      if (soFar.includes('87')) p2 = ['88', '87', '86', '89'];
    });
    expect(seen).toEqual(['91', '89', '88', '87', '86']);
  });

  it('drains randomized unchanged timelines with duplicates losslessly, in order and without repeats', async () => {
    const random = prng(7);
    for (let trial = 0; trial < 3000; trial++) {
      // Pages of fresh ids, with duplicates inside a page and an optional seam overlap with the previous page.
      const pages: string[][] = [];
      let next = 1000;
      for (let p = 0; p < 1 + Math.floor(random() * 4); p++) {
        const ids: string[] = [];
        const previous = pages.at(-1)?.at(-1);
        if (previous && random() < 0.5) ids.push(previous);
        for (let k = 0; k < 1 + Math.floor(random() * 8); k++) {
          ids.push(ids.length > 0 && random() < 0.5 ? ids[Math.floor(random() * ids.length)]! : String(next++));
        }
        pages.push(ids);
      }
      const count = 1 + Math.floor(random() * 5);
      expect(await drain(pagedFetch(pages), count), `trial ${trial}: ${JSON.stringify(pages)} count ${count}`).toEqual([
        ...new Set(pages.flat())
      ]);
    }
  });

  it('never loses a post under random insertions, deletions and duplicate entries between calls', async () => {
    const random = prng(11);
    for (let trial = 0; trial < 1500; trial++) {
      // Newest-first entries with a sort index, like X's timeline position; duplicate ids are separate entries.
      let nextId = 5000;
      let top = 1_000_000;
      const timeline: { id: string; sort: number }[] = [];
      for (let k = 0; k < 6 + Math.floor(random() * 30); k++) {
        const id = timeline.length > 0 && random() < 0.15 ? timeline[Math.floor(random() * timeline.length)]!.id : String(nextId++);
        timeline.push({ id, sort: top - k * 10 });
      }
      const pageSize = 2 + Math.floor(random() * 6);
      const fetchPage = async (up: string | null): Promise<Page> => {
        const below = up === null ? Number.POSITIVE_INFINITY : Number(up.slice(1));
        const entries = timeline.filter((entry) => entry.sort < below).slice(0, pageSize);
        const last = entries.at(-1);
        return { items: entries.map((entry) => ({ id: entry.id })), bottom: last ? `s${last.sort}` : 's-Infinity' };
      };
      const original = new Set(timeline.map((entry) => entry.id));
      const deleted = new Set<string>();
      const seen = await drain(fetchPage, 1 + Math.floor(random() * 4), (soFar) => {
        if (random() < 0.3) for (let k = 0; k < 1 + Math.floor(random() * 3); k++) timeline.unshift({ id: String(nextId++), sort: (top += 10) });
        if (random() < 0.3 && soFar.length > 0) {
          const victim = soFar[Math.floor(random() * soFar.length)]!;
          const index = timeline.findIndex((entry) => entry.id === victim);
          if (index >= 0) timeline.splice(index, 1);
          if (!timeline.some((entry) => entry.id === victim)) deleted.add(victim);
        }
      });
      const missing = [...original].filter((id) => !deleted.has(id) && !seen.includes(id));
      expect(missing, `trial ${trial}`).toEqual([]);
    }
  });
});
