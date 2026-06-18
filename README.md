# x-mcp

Read-only MCP server for public X/Twitter search and retrieval via `twitter.2-38.com`. Implemented as a TypeScript + Hono Cloudflare Worker.

日本語版は下にあります: [日本語](#日本語)

## Remote MCP endpoint

```text
https://x.mcp.2-38.com/mcp
```

Discovery metadata:

```text
https://x.mcp.2-38.com/.well-known/mcp.json
```

This server exposes MCP tools that call the existing public proxy endpoints under:

```text
https://twitter.2-38.com/api/fx/2/...
```

Example upstream call wrapped by `search_posts`:

```text
https://twitter.2-38.com/api/fx/2/search?q=from%3Ajack&feed=latest&count=10
```

## AI agent skill first

MCP tells an agent what tools exist, but a skill tells it **when and how to use them**. Before asking an AI agent to use this MCP, have it install or load the bundled skill:

```text
https://raw.githubusercontent.com/kandotrun/x-mcp/main/skills/x-mcp/SKILL.md
```

Full copy/paste prompts are available here:

- [`docs/agent-install-prompts.md`](docs/agent-install-prompts.md)

Short English prompt:

```text
Install or load this x-mcp skill first:
https://raw.githubusercontent.com/kandotrun/x-mcp/main/skills/x-mcp/SKILL.md

Then configure MCP server `x` with:
https://x.mcp.2-38.com/mcp

Verify tools/list includes search_posts and call search_posts with
{ "q": "from:jack", "feed": "latest", "count": 2 }.
Use this instead of x_search/xurl for public read-only X/Twitter search and retrieval through twitter.2-38.com.
```

## MCP configuration

### Hermes Agent

```bash
hermes skills inspect https://raw.githubusercontent.com/kandotrun/x-mcp/main/skills/x-mcp/SKILL.md
hermes skills install https://raw.githubusercontent.com/kandotrun/x-mcp/main/skills/x-mcp/SKILL.md --category social-media -y
hermes mcp add x --url https://x.mcp.2-38.com/mcp
hermes mcp test x
```

Or add this to `~/.hermes/config.yaml` and restart Hermes / start a new session:

```yaml
mcp_servers:
  x:
    url: "https://x.mcp.2-38.com/mcp"
```

Hermes will expose tools with the `mcp_x_` prefix, for example `mcp_x_search_posts`.

### Generic MCP clients

```json
{
  "mcpServers": {
    "x": {
      "url": "https://x.mcp.2-38.com/mcp"
    }
  }
}
```

Use your client's HTTP / Streamable HTTP MCP transport setting if it requires an explicit transport type.

## Tools

- `search_posts` — call `/2/search`
- `get_post` — call `/2/status/:id`
- `get_profile` — call `/2/profile/:handle`
- `get_profile_statuses` — call `/2/profile/:handle/statuses`
- `get_profile_media` — call `/2/profile/:handle/media`
- `get_trends` — call `/2/trends`
- `typeahead` — call `/2/typeahead`
- `get_openapi` — call `/2/openapi.json`

## Smoke test

```bash
curl -sS https://x.mcp.2-38.com/health
curl -sS https://x.mcp.2-38.com/.well-known/mcp.json
```

For an MCP-level smoke test, call `tools/list` and then `search_posts` using your MCP client. A successful `search_posts` call with `q=from:jack` returns JSON text containing:

```json
{
  "upstreamUrl": "https://twitter.2-38.com/api/fx/2/search?q=from%3Ajack&feed=latest&count=2",
  "status": 200
}
```

## Local development

```bash
npm install
cp wrangler.example.jsonc wrangler.jsonc
npm run check
npx wrangler dev --config wrangler.jsonc
```

`npm run check` regenerates local Worker runtime types from `wrangler.example.jsonc` and runs TypeScript type checking.

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

## Security and scope

- Public, unauthenticated, read-only MCP endpoint.
- Do not include secrets, private data, or access tokens in search queries.
- Not for posting, liking, reposting, following, DMs, notifications, private accounts, or authenticated timelines.
- Upstream availability, rate limits, and response shape depend on `twitter.2-38.com`.

---

# 日本語

`twitter.2-38.com` 経由で公開X/Twitter情報を read-only で検索・取得する MCP server です。実装は TypeScript + Hono の Cloudflare Worker です。

## 公開MCP endpoint

```text
https://x.mcp.2-38.com/mcp
```

Discovery metadata:

```text
https://x.mcp.2-38.com/.well-known/mcp.json
```

このMCPは、既存の公開proxy endpointを呼びます。

```text
https://twitter.2-38.com/api/fx/2/...
```

`search_posts` が包む upstream 呼び出し例:

```text
https://twitter.2-38.com/api/fx/2/search?q=from%3Ajack&feed=latest&count=10
```

## まずAIエージェントにskillを入れる

MCPだけだと「どの場面で、どう使うべきか」がAIに伝わりにくいので、このrepoにはAIエージェント向けskillを同梱しています。

Skill URL:

```text
https://raw.githubusercontent.com/kandotrun/x-mcp/main/skills/x-mcp/SKILL.md
```

コピペ用の導入プロンプトはこちらです。

- [`docs/agent-install-prompts.md`](docs/agent-install-prompts.md)

短い日本語プロンプト:

```text
まず以下の x-mcp skill をインストール、または読み込んでください。
https://raw.githubusercontent.com/kandotrun/x-mcp/main/skills/x-mcp/SKILL.md

その後、MCP server `x` を以下で設定してください。
https://x.mcp.2-38.com/mcp

`tools/list` に `search_posts` が出ることを確認し、
`search_posts` を { "q": "from:jack", "feed": "latest", "count": 2 } で試してください。
このMCPは twitter.2-38.com 経由の公開X/Twitter情報取得専用です。公開read-only用途では x_search/xurl ではなくこのMCPを使ってください。
```

## MCP設定

### Hermes Agent

```bash
hermes skills inspect https://raw.githubusercontent.com/kandotrun/x-mcp/main/skills/x-mcp/SKILL.md
hermes skills install https://raw.githubusercontent.com/kandotrun/x-mcp/main/skills/x-mcp/SKILL.md --category social-media -y
hermes mcp add x --url https://x.mcp.2-38.com/mcp
hermes mcp test x
```

CLIが使えない場合は、`~/.hermes/config.yaml` に次を追加してHermesを再起動、または新しいセッションを開始してください。

```yaml
mcp_servers:
  x:
    url: "https://x.mcp.2-38.com/mcp"
```

Hermesでは `mcp_x_search_posts` のように `mcp_x_` prefix付きでtoolが見えます。

### 汎用MCP client

```json
{
  "mcpServers": {
    "x": {
      "url": "https://x.mcp.2-38.com/mcp"
    }
  }
}
```

client側でtransport指定が必要な場合は、HTTP / Streamable HTTP MCP transportを選んでください。

## Tools

- `search_posts` — `/2/search` を呼ぶ
- `get_post` — `/2/status/:id` を呼ぶ
- `get_profile` — `/2/profile/:handle` を呼ぶ
- `get_profile_statuses` — `/2/profile/:handle/statuses` を呼ぶ
- `get_profile_media` — `/2/profile/:handle/media` を呼ぶ
- `get_trends` — `/2/trends` を呼ぶ
- `typeahead` — `/2/typeahead` を呼ぶ
- `get_openapi` — `/2/openapi.json` を呼ぶ

## Smoke test

```bash
curl -sS https://x.mcp.2-38.com/health
curl -sS https://x.mcp.2-38.com/.well-known/mcp.json
```

MCPレベルでは、clientから `tools/list` → `search_posts` を確認してください。`q=from:jack` の成功例では、返ってくるJSON textに次のような内容が含まれます。

```json
{
  "upstreamUrl": "https://twitter.2-38.com/api/fx/2/search?q=from%3Ajack&feed=latest&count=2",
  "status": 200
}
```

## ローカル開発

```bash
npm install
cp wrangler.example.jsonc wrangler.jsonc
npm run check
npx wrangler dev --config wrangler.jsonc
```

`npm run check` は `wrangler.example.jsonc` からローカルのWorker runtime型を再生成し、TypeScriptの型チェックを実行します。

ローカルMCP endpoint:

```text
http://localhost:8787/mcp
```

## デプロイ

```bash
cp wrangler.example.jsonc wrangler.jsonc
# 必要に応じて wrangler.jsonc の account_id を埋める
npm run deploy
```

`wrangler.jsonc` はアカウント固有の設定なのでgitignoreしています。

## セキュリティと範囲

- 公開・認証なし・read-only のMCP endpointです。
- search query に secret / private data / access token を入れないでください。
- 投稿、いいね、RT、フォロー、DM、通知、private account、認証timelineには使えません。
- upstreamの可用性、rate limit、response shapeは `twitter.2-38.com` 側に依存します。
