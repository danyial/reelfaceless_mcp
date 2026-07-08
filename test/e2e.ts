/**
 * MCP E2E: spawns the built server via stdio and exercises every tool
 * against a running ReelFaceless instance.
 *
 * Env: BASE (default http://localhost:3100), RF_KEY (API key), VIDEO (path).
 * Run from mcp/: npx tsx test/e2e.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BASE = process.env.BASE ?? "http://localhost:3100";
const RF_KEY = process.env.RF_KEY!;
const VIDEO = process.env.VIDEO!;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parse(result: any): any {
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      REELFACELESS_API_KEY: RF_KEY,
      REELFACELESS_BASE_URL: BASE,
    },
  });
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("1) tools:", tools.tools.map((t) => t.name).join(", "));

  const channels = parse(await client.callTool({ name: "list_channels", arguments: {} }));
  const channel = channels.channels.find((c: any) => c.status === "active");
  console.log(
    "2) list_channels:", channels.channels.length,
    "| schedule slots on first:", channels.channels[0]?.schedule?.length,
  );

  const upload = parse(
    await client.callTool({ name: "upload_video", arguments: { file_path: VIDEO } }),
  );
  console.log("3) upload_video:", upload.status, upload.media_id);

  const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
  const created = parse(
    await client.callTool({
      name: "create_post",
      arguments: {
        title: "MCP e2e test",
        body: "created via MCP",
        media_id: upload.media_id,
        targets: [
          {
            channel_id: channel.id,
            settings: { privacy_status: "private", privacy_level: "SELF_ONLY" },
          },
        ],
        schedule_mode: "custom",
        scheduled_at: at,
      },
    }),
  );
  console.log("4) create_post:", created.post.id, "→", created.targets[0].status);

  const status = parse(
    await client.callTool({ name: "get_post_status", arguments: { post_id: created.post.id } }),
  );
  console.log("5) get_post_status:", status.post.targets.length, "target(s)");

  const listed = parse(
    await client.callTool({ name: "list_posts", arguments: { status: "scheduled", limit: 5 } }),
  );
  console.log(
    "6) list_posts(scheduled):", listed.posts.length,
    "| enthält neuen Post:", listed.posts.some((p: any) => p.id === created.post.id),
  );

  const published = parse(
    await client.callTool({ name: "list_posts", arguments: { status: "published", limit: 1 } }),
  );
  if (published.posts[0]) {
    const metrics = parse(
      await client.callTool({
        name: "get_post_metrics",
        arguments: { post_id: published.posts[0].id },
      }),
    );
    console.log(
      "7) get_post_metrics (published):",
      JSON.stringify(metrics.targets[0]?.metrics),
    );
  } else {
    console.log("7) get_post_metrics: kein published Post — übersprungen");
  }

  // error path: bogus media id
  const bad = await client.callTool({
    name: "get_post_status",
    arguments: { post_id: "00000000-0000-0000-0000-000000000000" },
  });
  console.log("8) Fehlerpfad (unbekannte Post-ID):", bad.isError ? "isError ✓" : "FEHLT");

  console.log("CLEANUP_POST_ID=" + created.post.id);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
