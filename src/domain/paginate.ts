/**
 * Slice upstream pages to `count` items with lossless, stateless continuation.
 *
 * The cursor remembers which items of the current upstream page were already returned (fingerprints of their ids),
 * so every call rescans that page from the top and skips exactly those. Nothing depends on positions, so deletions,
 * insertions and duplicate entries between calls cannot make an unread item disappear. Posts added at the top of the
 * newest page meanwhile simply show up in a later call.
 *
 * One upstream page per call, plus a single hop when nothing on the current page is left to return.
 * An empty page ends the list (upstream returns a fresh bottom cursor even at the end).
 */
import { CURSOR_MAX_RETURNED, ITEM_BUDGET } from '../contract/limits';
import { fnv1a32, type CursorState } from './cursor';

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
  /** has_more is true but fewer than count items were left on this upstream page. */
  pageEnded: boolean;
  /** The list ended with an empty page after at least one earlier page. */
  endOfList: boolean;
  /** The very first page (no cursor) was empty. */
  firstPageEmpty: boolean;
};

const ID_RE = /^\d{1,20}$/;
const PRINT_LENGTH = 8;

function itemId(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const id = (item as { id?: unknown }).id;
  return typeof id === 'string' && ID_RE.test(id) ? id : undefined;
}

/** A 32-bit fingerprint of an id, as stored in next_cursor. */
export function fingerprint(id: string): string {
  return fnv1a32(id);
}

function prints(value: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + PRINT_LENGTH <= value.length; i += PRINT_LENGTH) set.add(value.slice(i, i + PRINT_LENGTH));
  return set;
}

export async function paginate<T>(options: PaginateOptions<T>): Promise<PaginateResult<T>> {
  const { count, fetchPage, project } = options;
  const budget = options.budget ?? ITEM_BUDGET;
  let { up, seam, returned } = options.state;
  let hopped = false;
  const base = { truncated: false, pageEnded: false, endOfList: false, firstPageEmpty: false };

  for (;;) {
    const page = await fetchPage(up);
    const items = page.items;
    if (items.length === 0) {
      const first = up === null && !hopped && returned === '';
      return { ...base, items: [], hasMore: false, endOfList: !first, firstPageEmpty: first };
    }

    // Already returned from this page (by fingerprint), or the previous page's last item (a seam overlap).
    const done = prints(returned);
    const seen = new Set<string>(seam === null ? [] : [seam]);
    const out: T[] = [];
    const added: string[] = [];
    let used = 2;
    let truncated = false;
    let lastOnPage = seam;
    let i = 0;
    for (; i < items.length; i++) {
      const id = itemId(items[i]);
      if (id !== undefined && (seen.has(id) || done.has(fingerprint(id)))) {
        lastOnPage = id;
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
        added.push(fingerprint(id));
        lastOnPage = id;
      }
    }

    if (i < items.length) {
      const next: CursorState = { up, seam, returned: (returned + added.join('')).slice(-CURSOR_MAX_RETURNED * PRINT_LENGTH) };
      return { ...base, items: out, hasMore: true, next, truncated };
    }
    // A bottom cursor equal to the one we asked with means the upstream did not advance.
    const bottom = page.bottom && page.bottom !== up ? page.bottom : null;
    if (out.length === 0 && bottom !== null && !hopped) {
      hopped = true;
      up = bottom;
      seam = lastOnPage;
      returned = '';
      continue;
    }
    if (bottom !== null) {
      return { ...base, items: out, hasMore: true, next: { up: bottom, seam: lastOnPage, returned: '' }, pageEnded: out.length < count };
    }
    return { ...base, items: out, hasMore: false, endOfList: out.length === 0 };
  }
}
