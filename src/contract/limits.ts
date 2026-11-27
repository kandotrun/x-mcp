/** Size, time and request limits. Changing one of these changes the documented contract. */

/** Every successful tool result stays under this many characters (Claude Code moves results over 50,000 to a file). */
export const MAX_RESULT_CHARS = 30_000;
/** Characters available for list items; the rest is reserved for the envelope and notes. */
export const ITEM_BUDGET = 29_000;

export const LIST_TEXT_MAX = 1_000;
export const POST_TEXT_MAX = 20_000;
export const ARTICLE_TEXT_MAX = 20_000;
export const QUOTE_TEXT_MAX_LIST = 280;
export const QUOTE_TEXT_MAX_POST = 1_000;
export const ALT_MAX = 300;
export const PREVIEW_MAX = 280;

export const UPSTREAM_TIMEOUT_MS = 10_000;
export const UPSTREAM_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_UPSTREAM_REQUESTS_PER_CALL = 3;
/** Shared by every tool call of one HTTP request, so a JSON-RPC batch cannot multiply upstream load. */
export const MAX_UPSTREAM_REQUESTS_PER_HTTP_REQUEST = 10;

/** Long enough for a next_cursor that carries a 0.1 raw cursor of any content (JSON escaping, UTF-8). */
export const CURSOR_MAX_LEN = 8_192;
export const CURSOR_MAX_OFFSET = 200;

export const TRENDS_UPSTREAM_MAX = 50;

/** Bounds applied by the MCP SDK before any tool code runs. */
export const MAX_REQUEST_BODY_BYTES = 65_536;
export const MAX_TOOL_INPUT_ELEMENTS = 32;
