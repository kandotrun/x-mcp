/**
 * Slice upstream pages to `count` items with lossless, stateless continuation.
 *
 * The cursor remembers which items of the current upstream page were already returned (their exact ids, or a content
 * key for entries without one), so every call rescans that page from the top and skips exactly those. Nothing depends on positions, so deletions,
 * insertions and duplicate entries between calls cannot make an unread item disappear. Posts added at the top of the
 * newest page meanwhile simply show up in a later call.
 *
 * One upstream page per call, plus a single hop when nothing on the current page is left to return.
 * An empty page ends the list (upstream returns a fresh bottom cursor even at the end).
 */
import { CURSOR_MAX_RETURNED, ITEM_BUDGET } from '../contract/limits';
import { pageTooLarge } from '../contract/messages';
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
/** Every key in next_cursor has this length: up to 20 decimal digits fit in 13 base-36 digits. */
export const KEY_LENGTH = 13;

function itemId(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const id = (item as { id?: unknown }).id;
  return typeof id === 'string' && ID_RE.test(id) ? id : undefined;
}

/** The exact id in base 36, so distinct ids never collide. Its first digit is at most "l" (20 decimal digits). */
export function idKey(id: string): string {
  return BigInt(id).toString(36).padStart(KEY_LENGTH, '0');
}

/** Entries without a numeric id (for example tombstones) get a stable key from their content; "z" marks it. */
function itemKey(item: unknown): string {
  const id = itemId(item);
  if (id !== undefined) return idKey(id);
  const json = JSON.stringify(item) ?? '';
  return `z${fnv1a32(json)}${fnv1a32(`#${json}`).slice(0, KEY_LENGTH - 9)}`;
}

function keys(value: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + KEY_LENGTH <= value.length; i += KEY_LENGTH) set.add(value.slice(i, i + KEY_LENGTH));
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

    // Skip what was already returned from this page, and the previous page's last item (a seam overlap).
    const skip = keys(returned);
    if (seam !== null) skip.add(seam);
    const out: T[] = [];
    const added: string[] = [];
    let used = 2;
    let truncated = false;
    let lastOnPage = seam;
    let i = 0;
    for (; i < items.length; i++) {
      const key = itemKey(items[i]);
      if (skip.has(key)) {
        lastOnPage = key;
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
      skip.add(key);
      added.push(key);
      lastOnPage = key;
    }

    if (i < items.length) {
      const remembered = returned + added.join('');
      if (remembered.length > CURSOR_MAX_RETURNED * KEY_LENGTH) throw pageTooLarge();
      return { ...base, items: out, hasMore: true, next: { up, seam, returned: remembered }, truncated };
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
