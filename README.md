# reelfaceless-mcp

MCP server (stdio) for the [ReelFaceless](https://reelfaceless.com) public API.
Schedule short-form video posts to YouTube and TikTok from Claude Desktop,
Claude Code or any other MCP client.

## Setup

You need an API key: ReelFaceless → workspace → **Settings → API** (Creator
plan and up). Plan quotas and rate limits apply automatically.

**Claude Code**

```bash
claude mcp add reelfaceless \
  --env REELFACELESS_API_KEY=rf_your_key \
  -- npx -y reelfaceless-mcp@latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "reelfaceless": {
      "command": "npx",
      "args": ["-y", "reelfaceless-mcp@latest"],
      "env": { "REELFACELESS_API_KEY": "rf_your_key" }
    }
  }
}
```

Optional: `REELFACELESS_BASE_URL` to point at a different instance.

## Tools

| Tool | Purpose |
|---|---|
| `list_channels` | Connected channels incl. posting schedule (needed for channel IDs) |
| `upload_video` | Upload a local MP4/MOV/WebM (max 500 MB), returns `media_id` |
| `create_post` | Schedule a post across channels — queue slots or a fixed time |
| `list_posts` | List posts, newest first, optional status filter |
| `get_post_status` | Per-channel status, remote URLs, error details |
| `get_post_metrics` | Latest views/likes/comments per channel for a published post |

Example prompt: *"Upload ~/exports/recap.mp4 and add it to the queue for all
my channels with the caption 'Weekly recap'."*

## Development

```bash
npm install
npm run build        # bundles to dist/index.js
npx tsx test/e2e.ts  # BASE=… RF_KEY=… VIDEO=… — full round-trip test
```
