/**
 * Every agent-facing error and note text. Ids (V*, C*, U*, N*) match the 0.2.0 contract spec.
 * Messages never include upstream bodies or URLs; caller input is rendered through echo().
 */
import { ToolError } from './errors';
import { CURSOR_MAX_RETURNED, MAX_RESULT_CHARS, TRENDS_UPSTREAM_MAX, UPSTREAM_TIMEOUT_MS } from './limits';
import { echo } from '../domain/text';

const ISSUES_URL = 'https://github.com/kandotrun/x-mcp/issues';
const BUG_HINT = `This is a bug in x-mcp, not in your arguments; report it at ${ISSUES_URL}.`;
const RETRY_ONCE_HINT = 'Retry once; if it fails again, try again later.';

// ---------------------------------------------------------------------------------------------
// V*: argument validation (before any upstream request)

export const invalidPostRef = (input: string) =>
  new ToolError({
    code: 'invalid_argument',
    retryable: false,
    message: `'${echo(input)}' is not a post ID or post URL.`,
    hint: 'Pass the numeric ID as a string or the post link, e.g. {"id":"20"} or {"id":"https://x.com/jack/status/20"}.'
  });

export const shortLink = () =>
  new ToolError({
    code: 'invalid_argument',
    retryable: false,
    message: 't.co short links cannot be expanded by this server.',
    hint: 'Open the link to get its x.com/<user>/status/<id> address, or pass the numeric post ID.'
  });

export const profileLinkAsPost = (input: string, handle: string) =>
  new ToolError({
    code: 'invalid_argument',
    retryable: false,
    message: `'${echo(input)}' is a profile link (@${handle}), not a post link.`,
    hint: `For the account call get_profile or get_profile_statuses with {"handle":"${handle}"}.`
  });

export const articleLinkAsPost = (input: string) =>
  new ToolError({
    code: 'invalid_argument',
    retryable: false,
    message: `'${echo(input)}' is an X Article link; its ID is not a post ID.`,
    hint: 'Pass the link of the post that shares the Article (x.com/<user>/status/<id>); get_profile_articles for the author lists it.'
  });

export const invalidHandle = (input: string) =>
  new ToolError({
    code: 'invalid_argument',
    retryable: false,
    message: `'${echo(input)}' is not an X handle or profile link.`,
    hint: 'Pass the username, e.g. {"handle":"nasa"}, {"handle":"@nasa"} or {"handle":"https://x.com/nasa"}.'
  });

export const numericAccountId = (input: string, possiblePostId?: string) =>
  new ToolError({
    code: 'invalid_argument',
    retryable: false,
    message: `'${echo(input)}' looks like a numeric ID; numeric account IDs are not supported.`,
    hint:
      possiblePostId === undefined
        ? 'Pass the @handle, e.g. {"handle":"nasa"}.'
        : `Pass the @handle, e.g. {"handle":"nasa"}. For a post ID call get_post with {"id":"${possiblePostId}"}.`
  });

export const nonXHost = (host: string) =>
  new ToolError({
    code: 'invalid_argument',
    retryable: false,
    message: `'${echo(host)}' is not an x.com or twitter.com link.`,
    hint: 'Pass the bare handle, e.g. {"handle":"nasa"}.'
  });

export const postLinkWithoutAccount = () =>
  new ToolError({
    code: 'invalid_argument',
    retryable: false,
    message: 'This post link has no account name in it.',
    hint: 'Call get_post with this link as id and read post.author.handle.'
  });

const UNKNOWN_TOOL_RE = /^(?:MCP error -?\d+: )?Tool [\s\S]* (?:not found|disabled)$/;

/** Schema validation failures and unknown tools, reported by the MCP SDK before any handler runs. */
export const invalidArguments = (detail: string) =>
  UNKNOWN_TOOL_RE.test(detail)
    ? // A fixed message: the SDK's text repeats the caller-supplied tool name.
      new ToolError({
        code: 'invalid_argument',
        retryable: false,
        message: 'Unknown tool name.',
        hint: 'Use one of the tool names from tools/list.'
      })
    : new ToolError({
        code: 'invalid_argument',
        retryable: false,
        message: detail.replace(/^MCP error -?\d+: /, ''),
        hint: "Fix the arguments as the error describes (see the tool's inputSchema) and call again."
      });

export const emptyQuery = (tool: 'search_posts' | 'typeahead') =>
  new ToolError({
    code: 'invalid_argument',
    retryable: false,
    message: 'q is empty.',
    hint:
      tool === 'search_posts'
        ? 'Pass keywords or operators, e.g. {"q":"from:nasa artemis"}.'
        : 'Pass part of a name, e.g. {"q":"nasa"}.'
  });

// ---------------------------------------------------------------------------------------------
// C*: cursors

const START_OVER = 'omit cursor to start again from the newest items.';

export const corruptCursor = () =>
  new ToolError({
    code: 'invalid_cursor',
    retryable: false,
    message: 'cursor is not a next_cursor issued by this server, or it was changed or cut off.',
    hint: `Pass next_cursor from the previous result exactly as returned, or ${START_OVER}`
  });

export const cursorScopeMismatch = (issuedFor: string) =>
  new ToolError({
    code: 'invalid_cursor',
    retryable: false,
    message: `This cursor was issued for ${issuedFor}, not for this call.`,
    hint: 'Use a cursor only with the tool and arguments that returned it (same handle, post or query, same include_replies), or omit cursor to start over.'
  });

export const cursorVersion = () =>
  new ToolError({
    code: 'invalid_cursor',
    retryable: false,
    message: 'cursor was issued by a different version of this server.',
    hint: 'Omit cursor to start again from the newest items.'
  });

// ---------------------------------------------------------------------------------------------
// U*: upstream outcomes

export const unexpectedResponse = () =>
  new ToolError({
    code: 'upstream_unavailable',
    retryable: true,
    message: 'The upstream service returned an unexpected response.',
    hint: RETRY_ONCE_HINT
  });

export const unexpectedRedirect = (status: number) =>
  new ToolError({
    code: 'upstream_unavailable',
    retryable: false,
    upstreamStatus: status,
    message: `The upstream service redirected unexpectedly (HTTP ${status}).`,
    hint: 'This X data cannot be retrieved right now; try again later.'
  });

export const invalidSnowflake = (postId: string) =>
  new ToolError({
    code: 'invalid_argument',
    retryable: false,
    upstreamStatus: 400,
    message: `'${echo(postId)}' is not a valid X post ID.`,
    hint: 'Post IDs are the digits after /status/ in a post link, e.g. "20".'
  });

export const proxyPathRejected = () =>
  new ToolError({
    code: 'internal',
    retryable: false,
    upstreamStatus: 400,
    message: 'x-mcp called an upstream path that the proxy does not allow.',
    hint: BUG_HINT
  });

export const queryRejected = () =>
  new ToolError({
    code: 'invalid_argument',
    retryable: false,
    upstreamStatus: 400,
    message: 'X rejected this query (HTTP 400).',
    hint: 'Simplify the query (plain keywords, at most one operator) and try again.'
  });

export const parameterRejected = () =>
  new ToolError({
    code: 'internal',
    retryable: false,
    upstreamStatus: 400,
    message: 'The upstream rejected a request parameter generated by x-mcp (HTTP 400).',
    hint: BUG_HINT
  });

export const postRestricted = (postId: string, status?: number) =>
  new ToolError({
    code: 'restricted',
    retryable: false,
    ...(status === undefined ? {} : { upstreamStatus: status }),
    message: `Post ${postId} is not publicly visible (protected account, or age-restricted or withheld content).`,
    hint: 'Only public posts can be read; get_profile shows whether the author is protected.'
  });

export const accountContentRestricted = (handle: string, status: number) =>
  new ToolError({
    code: 'restricted',
    retryable: false,
    upstreamStatus: status,
    message: `@${handle}'s content is not publicly visible.`,
    hint: 'Only public accounts can be read.'
  });

export const postNotFound = (postId: string, status?: number) =>
  new ToolError({
    code: 'not_found',
    retryable: false,
    ...(status === undefined ? {} : { upstreamStatus: status }),
    message: `Post ${postId} was not found; it may have been deleted, or the ID may be wrong.`,
    hint: 'Check the digits after /status/ in the link, or pass the full post link as id.'
  });

export const accountSuspended = (handle: string) =>
  new ToolError({
    code: 'restricted',
    retryable: false,
    upstreamStatus: 404,
    message: `@${handle} is suspended on X.`,
    hint: 'Suspended accounts cannot be read through this server.'
  });

export const accountNotFound = (handle: string) =>
  new ToolError({
    code: 'not_found',
    // The upstream occasionally answers "User not found" for accounts that exist.
    retryable: true,
    upstreamStatus: 404,
    message: `No public X account named '${handle}' was found.`,
    hint: 'Check the spelling (no @ needed; case-insensitive). If you are sure the account exists, retry once: the upstream occasionally answers not found for existing accounts.'
  });

export const accountProtected = (handle: string) =>
  new ToolError({
    code: 'restricted',
    retryable: false,
    message: `@${handle} is a protected account; only approved followers can see its posts.`,
    hint: 'get_profile still returns its public profile fields.'
  });

export const timelineMissing = (handle: string, what: string, listed: number | undefined) =>
  new ToolError({
    code: 'upstream_unavailable',
    retryable: true,
    message:
      listed === undefined
        ? `X answered "not found" for the ${what} of @${handle}, an account that exists.`
        : `X returned no ${what} for @${handle} although its profile lists ${listed}.`,
    hint: 'This is usually temporary; retry once in a few seconds.'
  });

export const requestBudgetExhausted = (budget: number) =>
  new ToolError({
    code: 'rate_limited',
    retryable: true,
    message: `This HTTP request already made ${budget} upstream requests, the most one request may make.`,
    hint: 'Send one tool call per request (JSON-RPC batches share one budget).'
  });

export const rateLimited = (retryAfterSeconds: number) =>
  new ToolError({
    code: 'rate_limited',
    retryable: true,
    upstreamStatus: 429,
    retryAfterSeconds,
    message: 'The upstream service is rate limiting requests (HTTP 429).',
    hint: `Wait ${retryAfterSeconds} seconds before calling again, and avoid parallel calls.`
  });

const FROM_OPERATOR_RE = /(?:^|\s)from:@?([A-Za-z0-9_]{1,30})\b/i;
const HANDLE_LIKE_RE = /^@?([A-Za-z0-9_]{1,30})$/;

export const searchUnavailable = (q: string) => {
  const from = FROM_OPERATOR_RE.exec(q)?.[1];
  return new ToolError({
    code: 'feature_unavailable',
    retryable: false,
    upstreamStatus: 503,
    message:
      'Keyword search is unavailable upstream right now (HTTP 503). This is not caused by your query, and retrying will not help.',
    hint:
      from === undefined
        ? 'For posts by a known account call get_profile_statuses, e.g. {"handle":"nasa","count":10}; for a known post call get_post with its link as id.'
        : `This query asks for posts from @${from}: call get_profile_statuses with {"handle":"${from}","count":10} and filter the results yourself.`
  });
};

export const typeaheadUnavailable = (q: string) => {
  const handle = HANDLE_LIKE_RE.exec(q.trim())?.[1] ?? 'nasa';
  return new ToolError({
    code: 'feature_unavailable',
    retryable: false,
    upstreamStatus: 503,
    message: 'Typeahead suggestions are unavailable upstream right now (HTTP 503); retrying will not help.',
    hint: `If you know or can guess the handle, check it with get_profile, e.g. {"handle":"${handle}"}.`
  });
};

export const pageTooLarge = () =>
  new ToolError({
    code: 'upstream_unavailable',
    retryable: false,
    message: `More than ${CURSOR_MAX_RETURNED} items were returned from one upstream page, more than a cursor can track, so this list cannot be paged further.`,
    hint: 'Use a larger count to read more of this page in fewer calls, or omit cursor to start again from the newest items.'
  });

export const pageMissing = () =>
  new ToolError({
    code: 'upstream_unavailable',
    retryable: true,
    message: 'X did not return this page of the list (it answered "not found" or an empty page twice in a row); this is usually temporary.',
    hint: 'Call again with the same cursor in a few seconds; nothing is skipped. If it keeps failing, omit cursor to start again from the newest items.'
  });

export const upstreamFailed = (status: number) =>
  new ToolError({
    code: 'upstream_unavailable',
    retryable: true,
    upstreamStatus: status,
    message: `The upstream service failed (HTTP ${status}).`,
    hint: 'Retry once; if it fails again, the data is temporarily unavailable.'
  });

export const unexpectedStatus = (status: number) =>
  new ToolError({
    code: 'upstream_unavailable',
    retryable: false,
    upstreamStatus: status,
    message: `The upstream service returned an unexpected status (HTTP ${status}).`,
    hint: 'Retrying is unlikely to help; try again later.'
  });

export const upstreamTimeout = () =>
  new ToolError({
    code: 'timeout',
    retryable: true,
    message: `The upstream service did not answer within ${UPSTREAM_TIMEOUT_MS / 1000} seconds.`,
    hint: 'Retry once; if it times out again, try again later.'
  });

export const upstreamUnreachable = () =>
  new ToolError({
    code: 'upstream_unavailable',
    retryable: true,
    message: 'The upstream service could not be reached.',
    hint: RETRY_ONCE_HINT
  });

export const upstreamTooLarge = () =>
  new ToolError({
    code: 'upstream_unavailable',
    retryable: false,
    message: 'The upstream response was too large to process.',
    hint: 'Retrying is unlikely to help; try again later.'
  });

export const internalError = () =>
  new ToolError({
    code: 'internal',
    retryable: false,
    message: 'x-mcp hit an internal error.',
    hint: `Retry once; if it happens again, report it at ${ISSUES_URL}.`
  });

// ---------------------------------------------------------------------------------------------
// N*: notes attached to successful results

const formatChars = (n: number) => n.toLocaleString('en-US');

export const notes = {
  pageEnded: (returned: number, count: number) =>
    `Returned ${returned} of ${count} requested because the upstream page ended; pass next_cursor as cursor for more.`,
  budget: (returned: number, noun: string) =>
    `Stopped at ${returned} ${noun} to keep this result under ${formatChars(MAX_RESULT_CHARS)} characters; pass next_cursor as cursor for the rest.`,
  noMore: (noun: string) => `No more ${noun}.`,
  cutShort: (noun: string) => `X offered more ${noun}, but with a cursor this server cannot pass on, so the list stops here.`,
  noSearchResults: 'No posts matched this query.',
  detailedTooLarge: `The detailed object exceeded ${formatChars(MAX_RESULT_CHARS)} characters, so the concise form is returned.`,
  itemsTooLarge: (plural: string) =>
    `Some ${plural} were too large to return and are listed as {"unavailable":"too_large"}; open them with their url.`,
  detailedItemsTooLarge: (plural: string) =>
    `${plural[0]?.toUpperCase() ?? ''}${plural.slice(1)} too large for detailed form are returned in concise form.`,
  noPostsWithoutReplies: (handle: string, listed: number) =>
    `X returned no posts without replies for @${handle}, although its profile lists ${listed} posts; try include_replies=true.`,
  noTrends: 'The upstream returned no trends right now; this is not an error in your request.',
  trendsClamped: `count was reduced to ${TRENDS_UPSTREAM_MAX}, the upstream maximum.`,
  protectedProfile:
    'This account is protected: its posts are not publicly visible, so get_profile_statuses and get_profile_media return code "restricted".',
  noSuggestions: 'No suggestions for this query.',
  noReposts: 'No reposts were returned for this post.'
} as const;
