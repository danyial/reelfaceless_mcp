/**
 * ReelFaceless MCP server (stdio).
 *
 * Env:
 *   REELFACELESS_API_KEY   required — workspace API key (rf_…)
 *   REELFACELESS_BASE_URL  optional — defaults to https://reelfaceless.com
 *
 * Wraps the public API; plan quotas and entitlements apply automatically.
 */
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_KEY = process.env.REELFACELESS_API_KEY;
const BASE_URL = (process.env.REELFACELESS_BASE_URL ?? "https://reelfaceless.com").replace(/\/$/, "");

if (!API_KEY) {
  console.error("REELFACELESS_API_KEY is not set");
  process.exit(1);
}

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

class ApiError extends Error {}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => null)) as
    | (T & { error?: { code: string; message: string } })
    | null;
  if (!response.ok) {
    const err = body?.error;
    throw new ApiError(
      err ? `${err.code}: ${err.message}` : `HTTP ${response.status}`,
    );
  }
  return body as T;
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

const server = new McpServer({ name: "reelfaceless", version: "0.1.0" });

server.registerTool(
  "list_channels",
  {
    description:
      "List the connected social channels (YouTube/TikTok) of the workspace, " +
      "including each channel's posting schedule (weekday 0=Sunday…6=Saturday, " +
      "time in the workspace timezone). Channel IDs are needed for create_post.",
    inputSchema: {},
  },
  async () => {
    try {
      return ok(await api("/channels"));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "upload_video",
  {
    description:
      "Upload a local video file (MP4, MOV or WebM, max 500 MB) and return its " +
      "media_id for create_post. Handles the presigned upload and verification.",
    inputSchema: {
      file_path: z.string().describe("Absolute path to the video file"),
    },
  },
  async ({ file_path }) => {
    try {
      const mime = MIME_BY_EXT[extname(file_path).toLowerCase()];
      if (!mime) throw new ApiError("unsupported_format: use .mp4, .mov or .webm");
      const info = await stat(file_path);

      const ticket = await api<{ media_id: string; upload_url: string }>("/media", {
        method: "POST",
        body: JSON.stringify({
          file_name: basename(file_path),
          mime_type: mime,
          size_bytes: info.size,
        }),
      });

      const bytes = await readFile(file_path);
      const put = await fetch(ticket.upload_url, {
        method: "PUT",
        headers: { "Content-Type": mime },
        body: bytes,
      });
      if (!put.ok) throw new ApiError(`upload failed: HTTP ${put.status}`);

      const finalized = await api<{ status: string }>(
        `/media/${ticket.media_id}/finalize`,
        { method: "POST" },
      );
      return ok({ media_id: ticket.media_id, status: finalized.status });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "create_post",
  {
    description:
      "Create and schedule a video post across one or more channels. " +
      "schedule_mode 'queue' assigns each channel its next free posting slot; " +
      "'custom' schedules all targets at scheduled_at (ISO 8601). Per-channel " +
      "settings are optional and inherit from title/body — YouTube: title, " +
      "description, privacy_status (public|unlisted|private); TikTok: caption, " +
      "privacy_level (PUBLIC_TO_EVERYONE|MUTUAL_FOLLOW_FRIENDS|SELF_ONLY).",
    inputSchema: {
      title: z.string().min(1).max(150),
      body: z.string().max(5000).optional().describe("Default caption/description for all channels"),
      media_id: z.string().uuid().describe("From upload_video"),
      targets: z
        .array(
          z.object({
            channel_id: z.string().uuid(),
            settings: z.record(z.unknown()).optional(),
          }),
        )
        .min(1),
      schedule_mode: z.enum(["queue", "custom"]),
      scheduled_at: z.string().datetime().optional().describe("Required for schedule_mode 'custom'"),
    },
  },
  async ({ title, body, media_id, targets, schedule_mode, scheduled_at }) => {
    try {
      if (schedule_mode === "custom" && !scheduled_at) {
        throw new ApiError("scheduled_at is required for schedule_mode 'custom'");
      }
      const result = await api("/posts", {
        method: "POST",
        body: JSON.stringify({
          title,
          body: body ?? "",
          media_id,
          targets: targets.map((t) => ({
            channel_id: t.channel_id,
            settings: t.settings ?? {},
          })),
          schedule:
            schedule_mode === "queue"
              ? { mode: "queue" }
              : { mode: "custom", at: scheduled_at },
        }),
      });
      return ok(result);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "list_posts",
  {
    description:
      "List posts of the workspace, newest first. Optional status filter " +
      "(draft|scheduled|publishing|published|failed|canceled) matches posts " +
      "with at least one target in that status.",
    inputSchema: {
      status: z
        .enum(["draft", "scheduled", "publishing", "published", "failed", "canceled"])
        .optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  async ({ status, limit }) => {
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (limit) params.set("limit", String(limit));
      const qs = params.size > 0 ? `?${params}` : "";
      return ok(await api(`/posts${qs}`));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_post_status",
  {
    description:
      "Get a post with per-channel target status, scheduled/published times, " +
      "remote URLs and error details.",
    inputSchema: { post_id: z.string().uuid() },
  },
  async ({ post_id }) => {
    try {
      return ok(await api(`/posts/${post_id}`));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_post_metrics",
  {
    description:
      "Get the latest platform metrics (views, likes, comments) per channel " +
      "for a published post, as of the last analytics sync.",
    inputSchema: { post_id: z.string().uuid() },
  },
  async ({ post_id }) => {
    try {
      return ok(await api(`/posts/${post_id}/metrics`));
    } catch (error) {
      return fail(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`reelfaceless-mcp ready (${BASE_URL})`);
