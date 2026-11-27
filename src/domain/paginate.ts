/**
 * Slice upstream pages to `count` items with lossless, stateless continuation.
 *
 * The cursor remembers which items of the current upstream page were already returned (their exact ids, or a content
 * key for entries without one), so every call rescans that page from the top and skips exactly those. Nothing depends
 * on positions, so deletions, insertions and duplicate entries between calls cannot make an unread item disappear.
 * Items added at the top of the newest page after the listing started are skipped, so a busy list cannot hold a drain
 * on its newest page.
 *
 * One upstream page per call, plus a single hop when nothing on the current page is left to return, and one retry per
 * call when a page after the first comes back empty or "not found" (the upstream answers "not found" transiently).
 * An empty list in either answer ends the list (the upstream returns a fresh bottom cursor even at the end); "not
 * found" twice never does.
 */
import { CURSOR_MAX_RETURNED, ITEM_BUDGET } from '../contract/limits';
import { pageMissing, pageTooLarge } from '../contract/messages';
import { fnv1a32, type CursorState } from './cursor';

export type Page = {
  items: readonly unknown[];
  bottom: string | null;
  /** The upstream answered "not found" or "no content" instead of a list. */
  missing?: boolean;
};

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
  /** That first page was a "not found" rather than an empty list. */
  firstPageMissing: boolean;
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

/** How many of the entries a call left unread on the newest page next_cursor remembers (see firstOld). */
export const STOP_KEYS = 20;

/**
 * Index on the newest page where the previous call's unread entries begin: unread entries above it arrived later.
 * It is the topmost of the first few entries that call left unread (stop). Taking the topmost is safe: an entry can
 * only show up above its place as a new copy (a repost), which merely skips fewer entries, while a copy below its
 * place (left when the upper copy is deleted) is outranked by the other stop entries. If none of them is on the page
 * (deleted, or pushed down to the next page), the entry returned last that is still there marks the spot; entries
 * returned earlier are not used, because one of them can stay on top while new entries arrive below it (a pinned
 * post). With none of them on the page, nothing tells new entries from old ones, so every entry is kept.
 */
function firstOld(itemKeys: readonly string[], returned: string, stop: string | undefined): number {
  let topmost = -1;
  for (let k = 0; stop !== undefined && k < stop.length; k += KEY_LENGTH) {
    const index = itemKeys.indexOf(stop.slice(k, k + KEY_LENGTH));
    if (index >= 0 && (topmost < 0 || index < topmost)) topmost = index;
  }
  if (topmost >= 0) return topmost;
  for (let k = returned.length - KEY_LENGTH; k >= 0; k -= KEY_LENGTH) {
    const index = itemKeys.indexOf(returned.slice(k, k + KEY_LENGTH));
    if (index >= 0) return index;
  }
  return 0;
}

export async function paginate<T>(options: PaginateOptions<T>): Promise<PaginateResult<T>> {
  const { count, fetchPage, project } = options;
  const budget = options.budget ?? ITEM_BUDGET;
  let { up, seam, returned } = options.state;
  let hopped = false;
  let retried = false;
  const base = { truncated: false, pageEnded: false, endOfList: false, firstPageEmpty: false, firstPageMissing: false };

  for (;;) {
    // Only the first page of a listing can be empty from the start; callers diagnose that case.
    const first = up === null && !hopped && returned === '';
    let page = await fetchPage(up);
    const emptyList = (answer: Page) => answer.items.length === 0 && answer.missing !== true;
    // Later pages come back empty transiently too: ask once more per call (one page, one retry and one hop at most).
    let askedTwice = false;
    let endSeen = emptyList(page);
    if (!first && page.items.length === 0 && !retried) {
      retried = true;
      askedTwice = true;
      page = await fetchPage(up);
      endSeen ||= emptyList(page);
    }
    const items = page.items;
    if (items.length === 0) {
      // This call already used its retry on the previous page, so let the next call ask for this one again.
      if (hopped && !askedTwice) return { ...base, items: [], hasMore: true, next: { up, seam, returned: '' }, pageEnded: true };
      // "Not found" twice is not how a list ends, and a page the previous call stopped on still had unread items.
      if (!first && (!endSeen || returned !== '')) throw pageMissing();
      return { ...base, items: [], hasMore: false, endOfList: !first, firstPageEmpty: first, firstPageMissing: first && page.missing === true };
    }

    // Skip what was already returned from this page, and the previous page's last item (a seam overlap).
    const itemKeys = items.map(itemKey);
    const skip = keys(returned);
    // On the newest page, skip the entries that arrived at its top after the listing started, or a list that grows
    // faster than it is read would never get past its newest page.
    const from = up === null ? firstOld(itemKeys, returned, options.state.stop) : 0;
    if (seam !== null) skip.add(seam);
    const out: T[] = [];
    const added: string[] = [];
    let used = 2;
    let truncated = false;
    let lastOnPage = seam;
    let i = from;
    for (; i < items.length; i++) {
      const key = itemKeys[i]!;
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
      const next: CursorState = { up, seam, returned: remembered };
      if (up === null) {
        const unread: string[] = [];
        for (let j = i; j < items.length && unread.length < STOP_KEYS; j++) {
          const key = itemKeys[j]!;
          if (!skip.has(key) && !unread.includes(key)) unread.push(key);
        }
        next.stop = unread.join('');
      }
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
