/**
 * End-to-end smoke test against a running x-mcp server, as a real MCP client.
 *
 *   node scripts/smoke.ts [mcp-url] [--offline]
 *
 * Default URL: http://localhost:8787/mcp. --offline skips checks that call the upstream (used in CI).
 * Exits non-zero when a check fails. A SEARCH_ENABLED drift (flag vs. live search state) is reported as a warning.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TOOL_NAMES } from '../src/contract/tools.ts';

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const target = new URL(args.find((arg) => !arg.startsWith('--')) ?? 'http://localhost:8787/mcp');

let failures = 0;
const pass = (message: string) => console.log(`  ok    ${message}`);
const fail = (message: string) => {
  failures++;
  console.log(`  FAIL  ${message}`);
};
const warn = (message: string) => console.log(`  warn  ${message}`);
const check = (condition: boolean, message: string, detail = '') => (condition ? pass(message) : fail(detail ? `${message}: ${detail}` : message));

type ToolResult = { isError: boolean; data: Record<string, unknown>; text: string };

async function callTool(client: Client, name: string, toolArgs: Record<string, unknown>): Promise<ToolResult> {
  const result = await client.callTool({ name, arguments: toolArgs });
  const text = (result.content as { type: string; text?: string }[])[0]?.text ?? '';
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Every tool result, including errors, is JSON.
    fail(`${name} returned text that is not JSON: ${text.slice(0, 120)}`);
  }
  return { isError: result.isError === true, data, text };
}

async function main(): Promise<void> {
  console.log(`x-mcp smoke test: ${target.href}${offline ? ' (offline)' : ''}`);

  const healthResponse = await fetch(new URL('/health', target));
  const health = (await healthResponse.json()) as Record<string, unknown>;
  check(
    healthResponse.status === 200 && health.ok === true,
    `GET /health (version ${String(health.version ?? 'unknown')})`,
    `HTTP ${healthResponse.status} ${JSON.stringify(health)}`
  );

  const discoveryResponse = await fetch(new URL('/.well-known/mcp.json', target));
  const discovery = (await discoveryResponse.json()) as { tools?: unknown };
  check(
    discoveryResponse.status === 200 && JSON.stringify(discovery.tools) === JSON.stringify(TOOL_NAMES),
    'GET /.well-known/mcp.json lists every tool',
    `HTTP ${discoveryResponse.status} ${JSON.stringify(discovery.tools)}`
  );

  const client = new Client({ name: 'x-mcp-smoke', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(target));
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  check(JSON.stringify(names) === JSON.stringify(TOOL_NAMES), `tools/list returns ${TOOL_NAMES.length} tools in contract order`, names.join(','));
  check(tools.every((tool) => tool.annotations?.readOnlyHint === true), 'every tool is annotated read-only');

  const openapi = await callTool(client, 'get_openapi', {});
  check(!openapi.isError && Array.isArray(openapi.data.tools), 'get_openapi returns the static capability summary');
  const invalid = await callTool(client, 'get_post', { id: 'not a post' });
  check(invalid.isError && invalid.data.code === 'invalid_argument', 'invalid input returns code invalid_argument', invalid.text);

  if (!offline) {
    const post = await callTool(client, 'get_post', { id: 'https://x.com/jack/status/20' });
    const p = post.data.post as { text?: string; author?: { handle?: string } } | undefined;
    check(!post.isError && p?.text === 'just setting up my twttr' && p.author?.handle === 'jack', 'get_post by URL returns jack/20', post.text);

    const profile = await callTool(client, 'get_profile', { handle: '@jack' });
    check(!profile.isError && (profile.data.user as { handle?: string } | undefined)?.handle?.toLowerCase() === 'jack', 'get_profile @jack', profile.text);

    const first = await callTool(client, 'get_profile_statuses', { handle: 'jack', count: 2 });
    const hasCursor = typeof first.data.next_cursor === 'string' && first.data.next_cursor !== '';
    const firstPosts = Array.isArray(first.data.posts) ? (first.data.posts as { id?: string }[]) : [];
    check(
      !first.isError && firstPosts.length <= 2 && first.data.returned === firstPosts.length && first.data.has_more === true && hasCursor,
      'get_profile_statuses enforces count=2 and returns next_cursor',
      first.text.slice(0, 300)
    );
    check(first.text.length < 10_000, `get_profile_statuses count=2 result is small (${first.text.length} chars)`);
    if (hasCursor) {
      const second = await callTool(client, 'get_profile_statuses', { handle: 'jack', count: 2, cursor: first.data.next_cursor });
      const firstIds = firstPosts.map((item) => item.id);
      const secondPosts = Array.isArray(second.data.posts) ? (second.data.posts as { id?: string }[]) : [];
      const secondIds = secondPosts.map((item) => item.id);
      // Entries without an id (tombstones) cannot be compared, so only ids are checked for repeats.
      const knownIds = secondIds.filter((id): id is string => typeof id === 'string');
      check(
        !second.isError &&
          secondIds.length > 0 &&
          secondIds.length <= 2 &&
          second.data.returned === secondIds.length &&
          new Set(knownIds).size === knownIds.length &&
          knownIds.every((id) => !firstIds.includes(id)),
        'next_cursor continues without repeats',
        second.text.slice(0, 300)
      );
    }

    const trends = await callTool(client, 'get_trends', { count: 3 });
    check(!trends.isError && Array.isArray(trends.data.trends), 'get_trends', trends.text.slice(0, 300));

    const search = await callTool(client, 'search_posts', { q: 'from:jack', count: 1 });
    const advertisedUnavailable = (tools.find((tool) => tool.name === 'search_posts')?.title ?? '').includes('unavailable');
    if (search.isError) {
      check(
        search.data.code === 'feature_unavailable' && typeof search.data.hint === 'string' && search.data.hint !== '',
        'search_posts fails with feature_unavailable and a hint',
        search.text
      );
      if (!advertisedUnavailable) warn('search is down upstream but SEARCH_ENABLED is "true": set it to "false" and redeploy');
    } else {
      // An empty result is valid; a result without a posts array is not.
      check(Array.isArray(search.data.posts), 'search_posts works upstream', search.text.slice(0, 300));
      if (advertisedUnavailable) warn('search works upstream again: set SEARCH_ENABLED to "true" and redeploy');
    }
  }

  await client.close();
  console.log(failures === 0 ? 'smoke test passed' : `smoke test failed: ${failures} check(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
