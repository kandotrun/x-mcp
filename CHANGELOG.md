# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-11-27

### Changed

- **Breaking:** tool results are now compact, agent-friendly JSON by default instead of the raw upstream payload wrapped in `{upstreamUrl, status, data}`. Single objects return `{post}` or `{user}`; lists return `{posts | users, returned, has_more, next_cursor?, truncated?, note?}`. Pass `response_format: "detailed"` for the full upstream objects (with rendered collage URLs removed).
- **Breaking:** errors are `{error, code, retryable, hint, retry_after_seconds?, upstream_status?}` and no longer include upstream bodies or URLs. Invalid argument values and unknown tool names use the same envelope (`code: "invalid_argument"`); a request whose JSON-RPC `params` are malformed (for example `arguments` sent as a string) still gets a JSON-RPC error.
- `count` is enforced by the server. Upstream pages ignore it (about 20 posts or 70 accounts per page), so 0.1 returned about 125,000 characters for `get_profile_statuses` with `count: 2`; 0.2 returns about 1,500. No result exceeds 30,000 characters. List text is cut at 1,000 characters; `get_post` returns the whole text of a post (up to 25,000 characters, X's maximum) and up to 20,000 characters of an X Article body. When a post does not fit in one result, its text and Article body are cut to the longest length that fits, and `post.text_truncated` or `post.article.text_truncated` is set; a post that does not fit even then comes back as `{id, url, unavailable: "too_large"}` with a note.
- `next_cursor` continues pagination within and across upstream pages without skipping posts, even when posts are deleted or added between calls (it remembers which posts of the current page were returned, and posts added at the top after the first call are normally skipped). A later page of an account's list that comes back "not found", which the upstream does transiently, or any later page that comes back empty is fetched once more; if it stays "not found", or a page that still had unread posts comes back empty, the call fails with a retryable `upstream_unavailable` error instead of ending the list. 0.1 raw upstream cursors are still accepted and forwarded verbatim, except values that start like a versioned x-mcp cursor (`xc` and digits, then a period), which get `invalid_cursor`.
- `get_post` accepts post URLs (x.com, twitter.com, mobile, `/photo/1` and query suffixes); handles accept `@name` and profile or post URLs.
- `search_posts` and `typeahead` fail fast with `feature_unavailable` and a concrete alternative while upstream search is disabled; their descriptions say so (`SEARCH_ENABLED` var).
- `get_trends` clamps `count` to the upstream maximum of 50 instead of failing; `typeahead` applies `count` itself.
- `get_openapi` is deprecated and returns a static endpoint summary.
- Tool descriptions and server instructions explain when to use each tool, what it returns and how to paginate.
- `GET` and `DELETE` on `/mcp` return 405 (the server is stateless); request bodies are limited to 64 KiB and tool arguments to 32 elements.
- Upstream requests time out after 10 seconds including the body, read at most 2 MiB, do not follow redirects, and are capped at 3 per tool call and 10 per HTTP request (JSON-RPC batches share the budget).
- Protected accounts are reported as `restricted` and reposts of unknown posts as `not_found` when the upstream answers the newest page of the list with HTTP 500. The upstream also answers "not found" by mistake for existing accounts, so `get_profile` and that check ask for the profile twice, and an account list whose first page answers "not found" is asked for again unless the profile shows nothing to list. An empty first page (HTTP 200) shows that the account exists: the profile then only adds the protected status and the count, and when a list needs that count but the profile keeps answering "not found", the call fails with a retryable `upstream_unavailable` instead of `not_found`. Account `not_found` is retryable for the same reason (post `not_found` is not).
- When the default `get_profile_statuses` timeline stays empty although the profile lists posts (for example an account that only replies), the result is empty with a note suggesting `include_replies: true`, instead of an error.

### Added

- `get_profile_articles`, `get_profile_followers`, `get_profile_following` and `get_post_reposts` tools.
- `include_replies` on `get_profile_statuses` and `include_about` on `get_profile`.
- Setup instructions for Claude Code, claude.ai / Claude Desktop, Codex, Cursor, VS Code, Gemini CLI, Antigravity, Devin Desktop / Windsurf, Cline, Zed and Hermes Agent.
- Tests (vitest), CI (GitHub Actions), Dependabot configuration, a `justfile` and an MCP smoke test (`scripts/smoke.ts`).

### Security

- Updated `@modelcontextprotocol/sdk` to 1.32.2 and enabled its request-size and input-element limits, `hono` to 4.13.22 and `zod` to 4.6.7, and refreshed transitive dependencies, which resolves the open Dependabot alerts.

### Maintenance

- Migrated from npm to pnpm 12 and from TypeScript 6 to 7; updated wrangler to 4.168.
- Split the Worker into contract, domain, upstream and handler modules.

## [0.1.0] - 2026-06-18

- Initial release: read-only MCP server with `search_posts`, `get_post`, `get_profile`, `get_profile_statuses`, `get_profile_media`, `get_trends`, `typeahead` and `get_openapi`.
