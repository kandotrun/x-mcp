# AGENTS.md

This repo contains `x-mcp`, a public read-only Streamable HTTP MCP server for X/Twitter search and retrieval via `twitter.2-38.com`. The implementation is a TypeScript + Hono Cloudflare Worker.

## Operating rules

- Keep the MCP read-only. Do not add write actions such as post, like, repost, follow, DM, notifications, or authenticated timeline access without explicit Kan approval.
- The Worker endpoint is `https://x.mcp.2-38.com/mcp`.
- The upstream proxy base is `https://twitter.2-38.com/api/fx`.
- Do not commit `wrangler.jsonc`, `.dev.vars`, `.env*`, Cloudflare account secrets, OAuth tokens, or API keys.
- Keep `wrangler.example.jsonc` safe and placeholder-based except public route/vars.
- Keep README and `docs/agent-install-prompts.md` bilingual when changing user-facing onboarding.
- Keep `skills/x-mcp/SKILL.md` focused on how agents should install/configure/use the MCP.

## Verification before commit

Run:

```bash
npm run check
npm run deploy:dry
```

For remote smoke testing after deployment:

```bash
curl -sS https://x.mcp.2-38.com/health
curl -sS https://x.mcp.2-38.com/.well-known/mcp.json
```

Then verify MCP `tools/list` and `search_posts` using an MCP client or the SDK.
