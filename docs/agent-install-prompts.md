# x-mcp agent install prompts / AIエージェント導入プロンプト

Use these prompts when you want another AI agent to install or load the x-mcp skill first, then configure and use the MCP server.

---

## Japanese / 日本語

```text
以下の x-mcp skill をインストール、または読み込んでください。

Skill URL:
https://raw.githubusercontent.com/kandotrun/x-mcp/main/skills/x-mcp/SKILL.md

その後、MCP server `x` を以下のURLで設定してください（Streamable HTTP、認証なし）。

https://x.mcp.2-38.com/mcp

クライアント別の設定方法は https://github.com/kandotrun/x-mcp/blob/main/README.ja.md#1-クライアントに接続する にあります。たとえば Claude Code なら次のとおりです。
claude mcp add --transport http --scope user x https://x.mcp.2-38.com/mcp

このMCPは、`twitter.2-38.com` 経由で公開X/Twitter情報を read-only で取得するためのものです。投稿・いいね・RT・DM・フォローなどの書き込み操作には使わないでください。

Kanの公開X/Twitter検索・取得では、既存の `x_search` や `xurl` よりこの `x-mcp` を優先してください。`xurl` は、認証済みAPIや投稿・いいね・RT・DMなどの明示的な書き込み操作が必要な場合だけ使ってください。

設定後、次を確認してください。

1. MCPの `tools/list` に `get_post`, `get_profile`, `get_profile_statuses`, `get_profile_media`, `get_profile_articles`, `get_profile_followers`, `get_profile_following`, `get_post_reposts`, `get_trends`, `search_posts`, `typeahead`, `get_openapi` が出ること。
2. `get_post` を `{ "id": "https://x.com/jack/status/20" }` で呼び、`post.text` が `just setting up my twttr`、`post.author.handle` が `jack` になること。

キーワード検索（`search_posts`, `typeahead`）は現在 upstream 側で停止しており、`code: "feature_unavailable"` とヒントが返ります。その場合はヒントに従い、アカウントが分かっていれば `get_profile_statuses`、投稿が分かっていれば `get_post` を使ってください。上流のエラーはMCPの接続結果と分けて報告し、検索結果が0件だったとは解釈しないでください。

以後、X/Twitterの公開情報を調べる依頼では、まずこの skill の使い方に従ってください。目的に合う最も狭いツールを選び、`count` は小さめから始め、返ってきたJSONの必要な項目だけを要約してください。続きが必要なら `next_cursor` をそのまま `cursor` に渡し、可能なら投稿URL・プロフィールURLを添えて回答してください。
```

### Hermes Agent用の追加指示

```text
Hermes Agentの場合は、可能なら以下のコマンド相当で skill と MCP を設定してください。

hermes skills inspect https://raw.githubusercontent.com/kandotrun/x-mcp/main/skills/x-mcp/SKILL.md
hermes skills install https://raw.githubusercontent.com/kandotrun/x-mcp/main/skills/x-mcp/SKILL.md --category social-media -y
hermes mcp add x --url https://x.mcp.2-38.com/mcp
hermes mcp test x

`hermes mcp add` は認証が必要かを対話的に聞いてきます。このサーバーは認証不要なので「n」と答えてください。

CLIが使えない場合は、`~/.hermes/config.yaml` に次を追加してください。

mcp_servers:
  x:
    url: "https://x.mcp.2-38.com/mcp"

設定変更後は新しいセッションを開始するか、`/reload-mcp` を実行してください。
```

---

## English

```text
Install or load the following x-mcp skill first.

Skill URL:
https://raw.githubusercontent.com/kandotrun/x-mcp/main/skills/x-mcp/SKILL.md

Then configure an MCP server named `x` with this URL (Streamable HTTP, no authentication):

https://x.mcp.2-38.com/mcp

Per-client setup is at https://github.com/kandotrun/x-mcp#1-connect-your-client. For example, in Claude Code:
claude mcp add --transport http --scope user x https://x.mcp.2-38.com/mcp

This MCP provides read-only public X/Twitter retrieval via `twitter.2-38.com`. Do not use it for posting, liking, reposting, DMs, following, notifications, private accounts, or any authenticated write action.

For Kan's public X/Twitter search and retrieval, prefer this `x-mcp` over existing `x_search` or `xurl`. Reserve `xurl` only for explicit authenticated API or write actions such as posting, liking, reposting, DMs, or media uploads.

After configuration, verify the following:

1. MCP `tools/list` includes `get_post`, `get_profile`, `get_profile_statuses`, `get_profile_media`, `get_profile_articles`, `get_profile_followers`, `get_profile_following`, `get_post_reposts`, `get_trends`, `search_posts`, `typeahead`, and `get_openapi`.
2. Calling `get_post` with `{ "id": "https://x.com/jack/status/20" }` returns `post.text` "just setting up my twttr" and `post.author.handle` "jack".

Keyword search (`search_posts`, `typeahead`) is currently disabled upstream and returns `code: "feature_unavailable"` with a hint. Follow the hint: use `get_profile_statuses` for a known account or `get_post` for a known post. Report upstream errors separately from the MCP connection result, and do not interpret them as zero matching posts.

For future public X/Twitter information requests, follow this skill: choose the narrowest tool, start with a small `count`, summarize only the relevant fields of the returned JSON, pass `next_cursor` back unchanged as `cursor` when you need more, and include source post/profile URLs when available.
```

### Additional instructions for Hermes Agent

```text
For Hermes Agent, configure the skill and MCP with commands equivalent to:

hermes skills inspect https://raw.githubusercontent.com/kandotrun/x-mcp/main/skills/x-mcp/SKILL.md
hermes skills install https://raw.githubusercontent.com/kandotrun/x-mcp/main/skills/x-mcp/SKILL.md --category social-media -y
hermes mcp add x --url https://x.mcp.2-38.com/mcp
hermes mcp test x

`hermes mcp add` asks interactively whether the server needs authentication. This server does not, so answer "n".

If the CLI is unavailable, add this to `~/.hermes/config.yaml`:

mcp_servers:
  x:
    url: "https://x.mcp.2-38.com/mcp"

Start a new session or run `/reload-mcp` after changing MCP configuration.
```
