---
name: x-mcp
description: Use and configure Kan's public read-only X/Twitter MCP server at https://x.mcp.2-38.com/mcp, backed by twitter.2-38.com FxTwitter API proxy. Load when an agent needs to search public X posts, inspect profiles, fetch post details, media timelines, trends, or typeahead suggestions through MCP.
version: 0.1.0
author: Kan Ninomiya / kandotrun
license: MIT
tags:
  - mcp
  - x
  - twitter
  - fxtwitter
  - social-media
  - search
---

# x-mcp Skill

Use this skill when you need an AI agent to configure or use Kan's public X/Twitter MCP server.

- MCP endpoint: `https://x.mcp.2-38.com/mcp`
- Discovery: `https://x.mcp.2-38.com/.well-known/mcp.json`
- Upstream proxy: `https://twitter.2-38.com/api/fx/2/...`
- Repository: `https://github.com/kandotrun/x-mcp`
- Transport: Streamable HTTP
- Access: public, no auth, read-only

## What this MCP is for

Use `x-mcp` for public, read-only X/Twitter lookups through Kan's `twitter.2-38.com` FxTwitter proxy:

- search public posts with X search syntax, e.g. `from:jack`, `#AI`, keywords
- fetch a single post by numeric status ID
- fetch a public profile by handle
- fetch a profile's recent posts or media posts
- fetch trends
- fetch typeahead suggestions
- inspect the upstream OpenAPI document

Do **not** use this MCP for posting, liking, retweeting, following, DMs, notifications, private accounts, or authenticated timeline access. It only wraps public read-only endpoints.

## Kan preference

For Kan's normal public X/Twitter search and retrieval requests, prefer this MCP over built-in `x_search` or the `xurl` CLI. Reserve `xurl` for explicit authenticated or write-capable X API operations that this read-only MCP cannot perform.

## Install / configure the MCP

### Hermes Agent

Prefer the Hermes MCP CLI if available:

```bash
hermes mcp add x --url https://x.mcp.2-38.com/mcp
hermes mcp test x
```

Or add this to `~/.hermes/config.yaml` and restart Hermes / start a new session:

```yaml
mcp_servers:
  x:
    url: "https://x.mcp.2-38.com/mcp"
```

Expected Hermes tool names after discovery are prefixed with the server name, for example:

```text
mcp_x_search_posts
mcp_x_get_post
mcp_x_get_profile
mcp_x_get_profile_statuses
mcp_x_get_profile_media
mcp_x_get_trends
mcp_x_typeahead
mcp_x_get_openapi
```

### Generic MCP clients

Use the remote/HTTP/Streamable HTTP server URL supported by your client:

```json
{
  "mcpServers": {
    "x": {
      "url": "https://x.mcp.2-38.com/mcp"
    }
  }
}
```

Some clients use `servers` instead of `mcpServers`, or require an explicit transport/type field. Keep the same URL and select the client's HTTP / Streamable HTTP MCP transport.

## Available tools and when to use them

### `search_posts`

Use for public X search queries. This wraps:

```text
https://twitter.2-38.com/api/fx/2/search
```

Arguments:

- `q` — required query string. Examples: `from:jack`, `#AI`, `open source`, `from:jack builderbot`
- `feed` — `latest` or `top`; default `latest`
- `count` — 1 to 100; default 10
- `cursor` — optional pagination cursor from a previous response

Example request concept:

```json
{
  "q": "from:jack",
  "feed": "latest",
  "count": 10
}
```

This calls the same upstream shape as:

```text
https://twitter.2-38.com/api/fx/2/search?q=from%3Ajack&feed=latest&count=10
```

### `get_post`

Use when you already have a numeric status ID and need post details.

```json
{ "id": "2067319680654594543" }
```

### `get_profile`

Use for public profile metadata.

```json
{ "handle": "jack" }
```

The handle may include or omit `@`; the server normalizes it.

### `get_profile_statuses`

Use for a public profile's recent posts.

```json
{ "handle": "jack", "count": 10 }
```

### `get_profile_media`

Use for a public profile's recent media posts.

```json
{ "handle": "jack", "count": 10 }
```

### `get_trends`

Use for public trend data.

```json
{ "count": 10 }
```

### `typeahead`

Use for account/query suggestions.

```json
{ "q": "jack", "count": 10 }
```

### `get_openapi`

Use when you need to inspect the upstream FxTwitter API schema.

## Verification checklist

After installing/configuring the MCP, verify all of these:

1. Health endpoint works:

   ```bash
   curl -sS https://x.mcp.2-38.com/health
   ```

2. Discovery returns endpoint/tool metadata:

   ```bash
   curl -sS https://x.mcp.2-38.com/.well-known/mcp.json
   ```

3. MCP `tools/list` includes `search_posts`.
4. A smoke `search_posts` call with `q="from:jack"`, `feed="latest"`, `count=2` returns status `200` and an `upstreamUrl` beginning with:

   ```text
   https://twitter.2-38.com/api/fx/2/search?q=from%3Ajack
   ```

## Response interpretation

Tool results are JSON serialized into MCP text content. Parse the text as JSON when possible.

Typical top-level fields:

```json
{
  "upstreamUrl": "https://twitter.2-38.com/api/fx/2/search?...",
  "status": 200,
  "data": { "code": 200, "results": [] }
}
```

Common `data` fields depend on the upstream endpoint. Search/profile timeline endpoints usually return `results` and may return `cursor` for pagination.

## Operational notes

- This is a public no-auth endpoint. Do not put private queries, secrets, or access tokens into search strings.
- The MCP is read-only, but it queries the public internet through `twitter.2-38.com`, so treat results as current external data and cite timestamps/URLs when reporting.
- Upstream availability, rate limits, and response shape are controlled by the underlying FxTwitter service and may change.
- Prefer small `count` values first, then paginate with `cursor` if needed.
- For user-facing summaries, include direct X URLs from returned posts/profiles when available.

## Agent behavior pattern

When a user asks for X/Twitter information:

1. Choose the narrowest tool:
   - known post ID → `get_post`
   - known handle/profile → `get_profile`, `get_profile_statuses`, or `get_profile_media`
   - query/hashtag/keyword → `search_posts`
   - suggestions → `typeahead`
2. Start with `feed="latest"` unless the user asks for popular/top results.
3. Start with `count=10` or less for quick checks.
4. Parse returned JSON text and summarize the relevant fields.
5. Include source URLs and mention that the data is public X/Twitter data via `twitter.2-38.com`.
