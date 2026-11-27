/**
 * Slice upstream pages to `count` items with lossless, stateless continuation.
 * One upstream page per call, plus a single hop only when nothing on the current page is left to return.
 * An empty page is the only end-of-list signal (upstream returns a fresh bottom cursor even at the end).
 */
import { ITEM_BUDGET } from '../contract/limits';
import type { CursorState } from './cursor';

export type Page = { items: readonly unknown[]; bottom: string | null };

export type PaginateOptions<T> = {
  state: CursorState;
  count: number;
  fetchPage: (up: string | null) => Promise<Page>;
  project: (item: unknown) => T;
  /** Characters available for the serialized items array. */
  budget?: number;
};

export type PaginateResult<T> = {
  items: T[];
  hasMore: boolean;
  next?: CursorState;
  /** The character budget, not count, ended this result. */
  truncated: boolean;
  /** has_more is true but fewer than count items fit on this upstream page. */
  pageEnded: boolean;
  /** The anchor disappeared since the previous call, so one item may repeat. */
  shifted: boolean;
  /** The list ended with an empty page after at least one earlier page. */
  endOfList: boolean;
  /** The very first page (no cursor) was empty. */
  firstPageEmpty: boolean;
};

const ANCHOR_RE = /^\d{1,20}$/;

function anchorId(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const id = (item as { id?: unknown }).id;
  return typeof id === 'string' && ANCHOR_RE.test(id) ? id : undefined;
}

/** Where to resume on a (possibly changed) page, given the previous offset and anchor id. */
export function resumeIndex(items: readonly unknown[], off: number, anc: string | null): { start: number; shifted: boolean } {
  const n = items.length;
  if (anc === null) return { start: Math.min(off, n), shifted: false };
  if (off === 0) {
    // A fresh page reached through the bottom cursor: only skip a seam overlap.
    for (let i = 0; i < Math.min(3, n); i++) if (anchorId(items[i]) === anc) return { start: i + 1, shifted: false };
    return { start: 0, shifted: false };
  }
  if (anchorId(items[off - 1]) === anc) return { start: off, shifted: false };
  let best = -1;
  for (let i = 0; i < n; i++) {
    if (anchorId(items[i]) !== anc) continue;
    const distance = Math.abs(i - (off - 1));
    const bestDistance = Math.abs(best - (off - 1));
    if (best === -1 || distance < bestDistance || (distance === bestDistance && i > best)) best = i;
  }
  if (best !== -1) return { start: best + 1, shifted: false };
  // The anchor itself was most likely deleted, so the rest of the page shifted left by one.
  return { start: Math.max(0, Math.min(off - 1, n)), shifted: true };
}

export async function paginate<T>(options: PaginateOptions<T>): Promise<PaginateResult<T>> {
  const { count, fetchPage, project } = options;
  const budget = options.budget ?? ITEM_BUDGET;
  let { up, off, anc } = options.state;
  let hopped = false;
  const base = { truncated: false, pageEnded: false, shifted: false, endOfList: false, firstPageEmpty: false };

  for (;;) {
    const page = await fetchPage(up);
    const items = page.items;
    if (items.length === 0) {
      const first = up === null && !hopped;
      return { ...base, items: [], hasMore: false, endOfList: !first, firstPageEmpty: first };
    }

    const { start, shifted } = resumeIndex(items, off, anc);
    const seen = new Set<string>();
    for (const item of items.slice(0, start)) {
      const id = anchorId(item);
      if (id !== undefined) seen.add(id);
    }

    const out: T[] = [];
    let used = 2;
    let truncated = false;
    let lastHandled = anc;
    let i = start;
    for (; i < items.length; i++) {
      const id = anchorId(items[i]);
      if (id !== undefined && seen.has(id)) {
        lastHandled = id;
        continue;
      }
      if (out.length === count) break;
      const projected = project(items[i]);
      const size = JSON.stringify(projected).length + 1;
      if (out.length > 0 && used + size > budget) {
        truncated = true;
        break;
      }
      out.push(projected);
      used += size;
      if (id !== undefined) {
        seen.add(id);
        lastHandled = id;
      }
    }

    if (i < items.length) {
      return { ...base, items: out, hasMore: true, next: { up, off: i, anc: lastHandled }, truncated, shifted };
    }
    // A bottom cursor equal to the one we asked with means the upstream did not advance.
    const bottom = page.bottom && page.bottom !== up ? page.bottom : null;
    if (out.length === 0 && bottom !== null && !hopped) {
      hopped = true;
      up = bottom;
      off = 0;
      anc = lastHandled;
      continue;
    }
    if (out.length === 0 && hopped) {
      // Two pages in a row had nothing new: treat the list as exhausted instead of looping.
      return { ...base, items: [], hasMore: false, endOfList: true, shifted };
    }
    if (bottom !== null) {
      return {
        ...base,
        items: out,
        hasMore: true,
        next: { up: bottom, off: 0, anc: lastHandled },
        pageEnded: out.length < count,
        shifted
      };
    }
    return { ...base, items: out, hasMore: false, endOfList: out.length === 0, shifted };
  }
}
