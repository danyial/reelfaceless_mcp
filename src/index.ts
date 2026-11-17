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
  "get_channel_info",
  {
    description:
      "Get live posting constraints for a TikTok channel straight from the " +
      "platform: which privacy levels the account allows, whether comments/duet/" +
      "stitch are disabled account-side, and the max video duration. Call this " +
      "before create_post for TikTok — TikTok's content-sharing guidelines " +
      "require honouring these, and guessing an unavailable privacy level fails " +
      "the post. YouTube channels are not supported.",
    inputSchema: { channel_id: z.string().uuid() },
  },
  async ({ channel_id }) => {
    try {
      return ok(await api(`/channels/${channel_id}/info`));
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
      "settings are optional and inherit from title/body. " +
      "YouTube settings: title, description, privacy_status (public|unlisted|private), " +
      "made_for_kids, contains_synthetic_media (AI disclosure), tags (string[]), " +
      "category_id, default_language (BCP-47), notify_subscribers, embeddable, " +
      "license (youtube|creativeCommon), public_stats_viewable. " +
      "TikTok settings: post_mode (direct|inbox), caption, privacy_level " +
      "(PUBLIC_TO_EVERYONE|" +
      "MUTUAL_FOLLOW_FRIENDS|FOLLOWER_OF_CREATOR|SELF_ONLY), disable_comment, " +
      "disable_duet, disable_stitch, video_cover_timestamp_ms, " +
      "brand_organic_toggle, brand_content_toggle, is_aigc (AI label). " +
      "Constraint: brand_content_toggle cannot be combined with SELF_ONLY. " +
      "post_mode 'inbox' uploads the video to the creator's TikTok drafts " +
      "instead of publishing it — they add caption and effects in the app, so " +
      "every other TikTok setting is ignored and no public URL comes back. " +
      "For direct posts, call get_channel_info first — only the privacy levels " +
      "it returns are valid for that account.",
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
  "update_post",
  {
    description:
      "Edit a post that has not gone out yet: title, body, per-channel settings, " +
      "schedule and which channels it targets. Send the FULL target list — " +
      "channels you omit are removed from the post. Omit body to keep the " +
      "current caption; pass an empty string to clear it. The video cannot be changed. " +
      "Targets that already published stay untouched and keep their channel; if " +
      "every target has published the call fails with nothing_editable. Settings " +
      "follow the same shape as create_post.",
    inputSchema: {
      post_id: z.string().uuid(),
      title: z.string().min(1).max(150),
      body: z
        .string()
        .max(5000)
        .optional()
        .describe("Default caption/description for all channels; omit to keep the current one"),
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
  async ({ post_id, title, body, targets, schedule_mode, scheduled_at }) => {
    try {
      if (schedule_mode === "custom" && !scheduled_at) {
        throw new ApiError("scheduled_at is required for schedule_mode 'custom'");
      }
      return ok(
        await api(`/posts/${post_id}`, {
          method: "PATCH",
          body: JSON.stringify({
            title,
            // Left out when not given: the API then keeps the stored caption.
            // Sending "" here used to wipe it on every title-only edit.
            ...(body !== undefined ? { body } : {}),
            targets: targets.map((t) => ({
              channel_id: t.channel_id,
              settings: t.settings ?? {},
            })),
            schedule:
              schedule_mode === "queue"
                ? { mode: "queue" }
                : { mode: "custom", at: scheduled_at },
          }),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "publish_post_now",
  {
    description:
      "Publish a scheduled post right away instead of waiting for its slot. " +
      "The worker picks it up within about 30 seconds. Pass channel_id to " +
      "publish only that channel's target. Fails if nothing is scheduled " +
      "anymore (already published, canceled, or currently publishing).",
    inputSchema: {
      post_id: z.string().uuid(),
      channel_id: z
        .string()
        .uuid()
        .optional()
        .describe("Limit to one channel; omit to publish every scheduled target"),
    },
  },
  async ({ post_id, channel_id }) => {
    try {
      return ok(
        await api(`/posts/${post_id}/publish`, {
          method: "POST",
          body: JSON.stringify(channel_id ? { channel_id } : {}),
        }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "cancel_post",
  {
    description:
      "Cancel a scheduled post so it does not go out. Pass channel_id to cancel " +
      "only that channel's target and leave the others scheduled. Only targets " +
      "that are still scheduled can be canceled — one that is already publishing " +
      "or published is past the point of no return, and the call fails with " +
      "not_scheduled if nothing is left to cancel. The video and the post stay " +
      "in the workspace.",
    inputSchema: {
      post_id: z.string().uuid(),
      channel_id: z
        .string()
        .uuid()
        .optional()
        .describe("Limit to one channel; omit to cancel every scheduled target"),
    },
  },
  async ({ post_id, channel_id }) => {
    try {
      return ok(
        await api(`/posts/${post_id}/cancel`, {
          method: "POST",
          body: JSON.stringify(channel_id ? { channel_id } : {}),
        }),
      );
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
