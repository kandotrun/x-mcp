/** Builds one stateless McpServer per request and wires the tool contract to the handlers. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { readConfig, type ConfigEnv } from './config';
import { errorResult, ToolError } from './contract/errors';
import { MAX_TOOL_INPUT_ELEMENTS } from './contract/limits';
import { internalError, invalidArguments } from './contract/messages';
import { describeTools, inputShapes, instructions, TOOL_ANNOTATIONS, TOOL_NAMES, type ToolArgs, type ToolName } from './contract/tools';
import * as handlers from './tools/handlers';
import type { ToolContext } from './tools/handlers';
import { createUpstreamClient, type FetchLike } from './upstream/client';
import { createSession, type LogLine, type SharedBudget } from './upstream/session';
import { VERSION } from './version';

export type ServerDeps = {
  fetch?: FetchLike;
  log?: (line: LogLine) => void;
  /** Upstream requests shared by every tool call this server handles (one server serves one HTTP request). */
  upstreamBudget?: number;
};

type Handler<N extends ToolName> = (args: ToolArgs<N>, context: ToolContext) => Promise<unknown>;

const HANDLERS: { [N in ToolName]: Handler<N> } = {
  search_posts: handlers.searchPosts,
  get_post: handlers.getPost,
  get_profile: handlers.getProfile,
  get_profile_statuses: handlers.getProfileStatuses,
  get_profile_media: handlers.getProfileMedia,
  get_trends: handlers.getTrends,
  typeahead: handlers.typeahead,
  get_openapi: handlers.getOpenapi,
  get_profile_articles: handlers.getProfileArticles,
  get_profile_followers: handlers.getProfileFollowers,
  get_profile_following: handlers.getProfileFollowing,
  get_post_reposts: handlers.getPostReposts
};

export const defaultLog = (line: LogLine) => console.log(JSON.stringify(line));

export function createServer(env: ConfigEnv | undefined, deps: ServerDeps = {}): McpServer {
  const log = deps.log ?? defaultLog;
  const config = readConfig(env, log);
  const flags = { searchEnabled: config.searchEnabled };
  const client = createUpstreamClient({ baseUrl: config.upstreamBaseUrl, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  const server = new McpServer(
    { name: 'x-mcp', version: VERSION },
    { instructions: instructions(flags), maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS }
  );
  const text = describeTools(flags);
  const shared: SharedBudget | undefined = deps.upstreamBudget === undefined ? undefined : { remaining: deps.upstreamBudget };

  // The SDK reports schema validation failures and unknown tools through its private createToolError(message), as
  // plain text. Route them through the same JSON error envelope as every other failure. test/tools.test.ts pins this.
  (server as unknown as { createToolError: (message: string) => CallToolResult }).createToolError = (message) =>
    errorResult(invalidArguments(message));

  for (const name of TOOL_NAMES) {
    const handler = HANDLERS[name] as Handler<ToolName>;
    server.registerTool(
      name,
      { title: text[name].title, description: text[name].description, inputSchema: inputShapes[name], annotations: TOOL_ANNOTATIONS },
      async (args: unknown) =>
        run(name, log, () =>
          handler(args as ToolArgs<ToolName>, { session: createSession(client, { log, ...(shared ? { shared } : {}) }), config })
        )
    );
  }
  return server;
}

async function run(name: ToolName, log: (line: LogLine) => void, call: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await call()) }] };
  } catch (error) {
    if (error instanceof ToolError) return errorResult(error);
    log({ evt: 'internal_error', tool: name, message: error instanceof Error ? error.message : String(error) });
    return errorResult(internalError());
  }
}
