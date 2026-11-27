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
    // validation errors are plain text
  }
  return { isError: result.isError === true, data, text };
}

async function main(): Promise<void> {
  console.log(`x-mcp smoke test: ${target.href}${offline ? ' (offline)' : ''}`);

  const health = (await (await fetch(new URL('/health', target))).json()) as Record<string, unknown>;
  check(health.ok === true, `GET /health (version ${String(health.version ?? 'unknown')})`, JSON.stringify(health));

  const discovery = (await (await fetch(new URL('/.well-known/mcp.json', target))).json()) as { tools?: unknown };
  check(JSON.stringify(discovery.tools) === JSON.stringify(TOOL_NAMES), 'GET /.well-known/mcp.json lists every tool', JSON.stringify(discovery.tools));

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
    check(!first.isError && Number(first.data.returned) <= 2 && first.data.has_more === true, 'get_profile_statuses enforces count=2', first.text.slice(0, 300));
    check(first.text.length < 10_000, `get_profile_statuses count=2 result is small (${first.text.length} chars)`);
    if (typeof first.data.next_cursor === 'string') {
      const second = await callTool(client, 'get_profile_statuses', { handle: 'jack', count: 2, cursor: first.data.next_cursor });
      const firstIds = (first.data.posts as { id?: string }[]).map((item) => item.id);
      const secondIds = ((second.data.posts as { id?: string }[] | undefined) ?? []).map((item) => item.id);
      check(!second.isError && secondIds.length > 0 && secondIds.every((id) => !firstIds.includes(id)), 'next_cursor continues without repeats', second.text.slice(0, 300));
    }

    const trends = await callTool(client, 'get_trends', { count: 3 });
    check(!trends.isError && Array.isArray(trends.data.trends), 'get_trends', trends.text.slice(0, 300));

    const search = await callTool(client, 'search_posts', { q: 'from:jack', count: 1 });
    const advertisedUnavailable = (tools.find((tool) => tool.name === 'search_posts')?.title ?? '').includes('unavailable');
    if (search.isError) {
      check(search.data.code === 'feature_unavailable', 'search_posts fails with feature_unavailable and a hint', search.text);
      if (!advertisedUnavailable) warn('search is down upstream but SEARCH_ENABLED is "true": set it to "false" and redeploy');
    } else {
      pass('search_posts works upstream');
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
