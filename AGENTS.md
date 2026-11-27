# AGENTS.md

This repo contains `x-mcp`, a public read-only Streamable HTTP MCP server for X/Twitter retrieval via `twitter.2-38.com`. The implementation is a TypeScript + Hono Cloudflare Worker.

## Operating rules

- Keep the MCP read-only. Do not add write actions such as post, like, repost, follow, DM, notifications, or authenticated timeline access without explicit Kan approval.
- The Worker endpoint is `https://x.mcp.2-38.com/mcp`.
- The upstream proxy base is `https://twitter.2-38.com/api/fx`.
- Do not commit `wrangler.jsonc`, `.dev.vars`, `.env*`, Cloudflare account secrets, OAuth tokens, or API keys.
- Keep `wrangler.example.jsonc` safe and placeholder-based except public route/vars.
- Keep `README.md` (English) and `README.ja.md` (Japanese) in sync, and `docs/agent-install-prompts.md` bilingual, when changing user-facing onboarding.
- Keep `skills/x-mcp/SKILL.md` focused on how agents should install/configure/use the MCP.
- Never name the upstream project in public copy or tool output (`test/docs.test.ts` and `test/contract.test.ts` enforce this).
- Tool names, their order and v0.1 parameters are a public contract: only add tools and loosen constraints. `test/contract.test.ts` guards this against `test/fixtures/tools-list-0.1.json`; update the committed `test/__snapshots__/tools-list.*.json` deliberately with `pnpm vitest run -u` when the contract changes.
- Keep test fixtures synthetic (fictional handles and texts), as generated for `test/fixtures/`.
- When the version changes, update `src/version.ts`, `package.json`, the `SKILL.md` frontmatter and `CHANGELOG.md` together (a test checks the first three).

## Layout

- `src/contract/`: tool schemas and descriptions, output envelopes, messages, limits
- `src/domain/`: pure logic (normalization, cursors, pagination, projection, classification)
- `src/upstream/`: the only I/O (routes, HTTP client, per-call session)
- `src/tools/handlers.ts`, `src/server.ts`, `src/app.ts`, `src/worker.ts` (default export only)

## Verification before commit

Run (pnpm and just; see `justfile`):

```bash
just check   # pnpm run check: wrangler types + TypeScript for src and tests
just test    # pnpm test
just build   # pnpm run build: wrangler dry-run bundle with wrangler.example.jsonc
```

For an end-to-end check in workerd, run `just dev` in one terminal and `just smoke` in another.

For remote smoke testing after deployment:

```bash
curl -sS https://x.mcp.2-38.com/health
curl -sS https://x.mcp.2-38.com/.well-known/mcp.json
just smoke-remote
```

`just smoke-remote` verifies MCP `tools/list`, `get_post` (jack/20), pagination and the `search_posts` fallback, and warns when `SEARCH_ENABLED` no longer matches the live upstream search state.
