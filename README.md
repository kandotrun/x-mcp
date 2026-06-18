# x-mcp

Read-only MCP server for Kan's `twitter.2-38.com` FxTwitter API proxy.

## Remote MCP endpoint

```text
https://x.mcp.2-38.com/mcp
```

This server exposes MCP tools that call the existing public proxy endpoints under:

```text
https://twitter.2-38.com/api/fx/2/...
```

Example upstream call wrapped by `search_posts`:

```text
https://twitter.2-38.com/api/fx/2/search?q=from%3Ajack&feed=latest&count=10
```

## Tools

- `search_posts` — call `/2/search`
- `get_post` — call `/2/status/:id`
- `get_profile` — call `/2/profile/:handle`
- `get_profile_statuses` — call `/2/profile/:handle/statuses`
- `get_profile_media` — call `/2/profile/:handle/media`
- `get_trends` — call `/2/trends`
- `typeahead` — call `/2/typeahead`
- `get_openapi` — call `/2/openapi.json`

## Local development

```bash
npm install
cp wrangler.example.jsonc wrangler.jsonc
npm run check
npx wrangler dev --config wrangler.jsonc
```

MCP endpoint locally:

```text
http://localhost:8787/mcp
```

## Deploy

```bash
cp wrangler.example.jsonc wrangler.jsonc
# Fill account_id in wrangler.jsonc if needed.
npm run deploy
```

`wrangler.jsonc` is intentionally gitignored so account-specific deployment config stays local.
