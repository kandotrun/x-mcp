# x-mcp agent install prompts / AIエージェント導入プロンプト

Use these prompts when you want another AI agent to install or load the x-mcp skill first, then configure and use the MCP server.

---

## Japanese / 日本語

```text
以下の x-mcp skill をインストール、または読み込んでください。

Skill URL:
https://raw.githubusercontent.com/kandotrun/x-mcp/main/skills/x-mcp/SKILL.md

その後、MCP server `x` を以下のURLで設定してください。

https://x.mcp.2-38.com/mcp

このMCPは、Kanの `twitter.2-38.com` FxTwitter API proxy を read-only で呼ぶためのものです。投稿・いいね・RT・DM・フォローなどの書き込み操作には使わず、公開X/Twitter情報の検索・取得だけに使ってください。

設定後、次を確認してください。

1. MCPの `tools/list` に `search_posts`, `get_post`, `get_profile`, `get_profile_statuses`, `get_profile_media`, `get_trends`, `typeahead`, `get_openapi` が出ること。
2. `search_posts` を `{ "q": "from:jack", "feed": "latest", "count": 2 }` で呼び、`upstreamUrl` が `https://twitter.2-38.com/api/fx/2/search?q=from%3Ajack...` になり、`status` が `200` になること。

以後、X/Twitterの公開情報を調べる依頼では、まずこの skill の使い方に従い、最小限の count でMCP toolを呼び、返ってきたJSONを要約し、可能なら投稿URL・プロフィールURLを添えて回答してください。
```

### Hermes Agent用の追加指示

```text
Hermes Agentの場合は、可能なら以下のコマンド相当で skill と MCP を設定してください。

hermes skills inspect https://raw.githubusercontent.com/kandotrun/x-mcp/main/skills/x-mcp/SKILL.md
hermes skills install https://raw.githubusercontent.com/kandotrun/x-mcp/main/skills/x-mcp/SKILL.md --category social-media -y
hermes mcp add x --url https://x.mcp.2-38.com/mcp
hermes mcp test x

CLIが使えない場合は、`~/.hermes/config.yaml` に次を追加してください。

mcp_servers:
  x:
    url: "https://x.mcp.2-38.com/mcp"

設定変更後はHermesを再起動、または新しいセッションを開始してください。
```

---

## English

```text
Install or load the following x-mcp skill first.

Skill URL:
https://raw.githubusercontent.com/kandotrun/x-mcp/main/skills/x-mcp/SKILL.md

Then configure an MCP server named `x` with this URL:

https://x.mcp.2-38.com/mcp

This MCP is a read-only wrapper around Kan's `twitter.2-38.com` FxTwitter API proxy. Use it only for public X/Twitter search and retrieval. Do not use it for posting, liking, reposting, DMs, following, notifications, private accounts, or any authenticated write action.

After configuration, verify the following:

1. MCP `tools/list` includes `search_posts`, `get_post`, `get_profile`, `get_profile_statuses`, `get_profile_media`, `get_trends`, `typeahead`, and `get_openapi`.
2. Calling `search_posts` with `{ "q": "from:jack", "feed": "latest", "count": 2 }` returns an `upstreamUrl` starting with `https://twitter.2-38.com/api/fx/2/search?q=from%3Ajack...` and `status: 200`.

For future public X/Twitter information requests, follow this skill: choose the narrowest MCP tool, start with a small count, parse the returned JSON text, summarize only relevant fields, and include source post/profile URLs when available.
```

### Additional instructions for Hermes Agent

```text
For Hermes Agent, configure the skill and MCP with commands equivalent to:

hermes skills inspect https://raw.githubusercontent.com/kandotrun/x-mcp/main/skills/x-mcp/SKILL.md
hermes skills install https://raw.githubusercontent.com/kandotrun/x-mcp/main/skills/x-mcp/SKILL.md --category social-media -y
hermes mcp add x --url https://x.mcp.2-38.com/mcp
hermes mcp test x

If the CLI is unavailable, add this to `~/.hermes/config.yaml`:

mcp_servers:
  x:
    url: "https://x.mcp.2-38.com/mcp"

Restart Hermes or start a new session after changing MCP configuration.
```
