#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { stat } from "node:fs/promises";
import { Graph, GraphError, loadConfig } from "./graph.js";

const graph = new Graph(loadConfig());
const server = new McpServer({ name: "instagram-aitropos", version: "1.0.0" });

// ---------- helpers ----------
const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
const fail = (e: unknown) => ({
  isError: true,
  content: [
    {
      type: "text" as const,
      text:
        e instanceof GraphError
          ? `${e.message}${e.details ? "\n" + JSON.stringify(e.details) : ""}`
          : `Error: ${(e as Error).message}`,
    },
  ],
});

type Annot = { readOnly?: boolean; destructive?: boolean; publishes?: boolean };
function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  annot: Annot,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
) {
  server.registerTool(
    name,
    {
      description,
      inputSchema: shape,
      annotations: {
        readOnlyHint: !!annot.readOnly,
        destructiveHint: !!annot.destructive,
        openWorldHint: true,
      },
    },
    (async (args: any) => {
      try {
        return text(await handler(args));
      } catch (e) {
        return fail(e);
      }
    }) as any,
  );
}

const igUserId = z.string().optional().describe("ID de la cuenta IG. Por defecto IG_USER_ID o la cuenta del token.");
const fields = z.string().optional().describe("Campos separados por coma.");
const limit = z.number().int().min(1).max(100).optional();
const after = z.string().optional().describe("Cursor de paginación (paging.cursors.after).");
const waitSec = z.number().int().min(0).max(1800).default(300).describe("Segundos máx. esperando el procesamiento del video.");

const MEDIA_FIELDS =
  "id,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,username,is_comment_enabled,shortcode,owner";

// ---------- cuenta ----------
tool(
  "ig_get_account",
  "Perfil de la cuenta profesional de Instagram (username, seguidores, bio, etc.).",
  { ig_user_id: igUserId, fields },
  { readOnly: true },
  async ({ ig_user_id, fields: f }) => {
    const id = await graph.userId(ig_user_id);
    return graph.request("GET", id, {
      fields:
        f ??
        "id,user_id,username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count,account_type",
    });
  },
);

tool(
  "ig_get_publishing_limit",
  "Cuota de publicación de las últimas 24h (límite de 100 posts por API cada 24h) y uso actual.",
  { ig_user_id: igUserId },
  { readOnly: true },
  async ({ ig_user_id }) => {
    const id = await graph.userId(ig_user_id);
    return graph.request("GET", `${id}/content_publishing_limit`, { fields: "config,quota_usage" });
  },
);

tool(
  "ig_refresh_token",
  "Renueva un long-lived token de Instagram Login (válido 60 días; debe tener ≥24h de antigüedad). Devuelve el nuevo token: guardalo en IG_ACCESS_TOKEN.",
  {},
  {},
  async () =>
    graph.request("GET", "refresh_access_token", { grant_type: "ig_refresh_token" }, { noVersion: true }),
);

tool(
  "ig_exchange_token",
  "Canjea un short-lived token por uno long-lived (60 días). Requiere IG_APP_SECRET. Solo Instagram Login.",
  {},
  {},
  async () => {
    if (!graph.cfg.appSecret) throw new Error("Falta IG_APP_SECRET.");
    return graph.request(
      "GET",
      "access_token",
      { grant_type: "ig_exchange_token", client_secret: graph.cfg.appSecret },
      { noVersion: true },
    );
  },
);

// ---------- publicación ----------
const userTagsSchema = z
  .array(z.union([z.string(), z.object({ username: z.string(), x: z.number().min(0).max(1), y: z.number().min(0).max(1) })]))
  .optional();

async function finish(
  userId: string,
  containerId: string,
  { publish, wait, label }: { publish: boolean; wait: number; label: string },
) {
  if (!publish) return { container_id: containerId, published: false, note: "Contenedor creado; publicalo con ig_publish_container." };
  if (wait > 0) await graph.waitForContainer(containerId, wait);
  const pub = await graph.publishContainer(userId, containerId);
  const media = await graph.request("GET", pub.id, { fields: "id,permalink,media_type,media_product_type,timestamp" });
  return { published: true, kind: label, container_id: containerId, media };
}

tool(
  "ig_publish_reel",
  "PUBLICA un Reel en Instagram (visible al instante). Fuente: video_url (HTTPS público) o file_path (archivo local, se sube con resumable upload). Espera el procesamiento y publica. Con publish=false solo crea el contenedor. Video: MP4/MOV, H.264/HEVC, AAC, 9:16 recomendado, 3s–15min, ≤300MB.",
  {
    video_url: z.string().url().optional().describe("URL pública del video."),
    file_path: z.string().optional().describe("Ruta local al video (alternativa a video_url)."),
    caption: z.string().max(2200).optional(),
    share_to_feed: z.boolean().optional().describe("Mostrar también en el feed/grilla (default de Meta: true)."),
    cover_url: z.string().url().optional().describe("URL de la portada."),
    thumb_offset: z.number().int().min(0).optional().describe("Milisegundo del video a usar como portada."),
    audio_name: z.string().optional().describe("Nombre del audio original."),
    location_id: z.string().optional(),
    collaborators: z.array(z.string()).max(3).optional().describe("Usernames invitados como colaboradores."),
    user_tags: userTagsSchema.describe("Usernames a etiquetar."),
    trial_reel: z
      .enum(["MANUAL", "SS_PERFORMANCE"])
      .optional()
      .describe("Publicar como Trial Reel (solo no seguidores). Estrategia de graduación."),
    publish: z.boolean().default(true),
    wait_seconds: waitSec,
    ig_user_id: igUserId,
  },
  { publishes: true },
  async (a) => {
    if (!a.video_url && !a.file_path) throw new Error("Indicá video_url o file_path.");
    if (a.video_url && a.file_path) throw new Error("Usá solo uno: video_url o file_path.");
    const id = await graph.userId(a.ig_user_id);
    const params: Record<string, unknown> = {
      media_type: "REELS",
      caption: a.caption,
      share_to_feed: a.share_to_feed,
      cover_url: a.cover_url,
      thumb_offset: a.thumb_offset,
      audio_name: a.audio_name,
      location_id: a.location_id,
      collaborators: a.collaborators,
      user_tags: a.user_tags,
      trial_params: a.trial_reel ? { graduation_strategy: a.trial_reel } : undefined,
    };
    if (a.video_url) params.video_url = a.video_url;
    else {
      await stat(a.file_path!); // falla temprano si no existe
      params.upload_type = "resumable";
    }
    const c = await graph.request("POST", `${id}/media`, params);
    if (a.file_path) {
      const up = await graph.resumableUpload(c.uri, a.file_path);
      if (up.success === false) throw new Error(`Falló la subida: ${JSON.stringify(up)}`);
    }
    return finish(id, c.id, { publish: a.publish, wait: a.wait_seconds, label: "REELS" });
  },
);

tool(
  "ig_publish_photo",
  "PUBLICA una foto (JPEG) en el feed. image_url debe ser HTTPS público.",
  {
    image_url: z.string().url(),
    caption: z.string().max(2200).optional(),
    alt_text: z.string().optional(),
    location_id: z.string().optional(),
    collaborators: z.array(z.string()).max(3).optional(),
    user_tags: userTagsSchema,
    publish: z.boolean().default(true),
    ig_user_id: igUserId,
  },
  { publishes: true },
  async (a) => {
    const id = await graph.userId(a.ig_user_id);
    const c = await graph.request("POST", `${id}/media`, {
      image_url: a.image_url,
      caption: a.caption,
      alt_text: a.alt_text,
      location_id: a.location_id,
      collaborators: a.collaborators,
      user_tags: a.user_tags,
    });
    return finish(id, c.id, { publish: a.publish, wait: 60, label: "IMAGE" });
  },
);

tool(
  "ig_publish_carousel",
  "PUBLICA un carrusel de 2–10 ítems (imágenes y/o videos, con URLs HTTPS públicas).",
  {
    items: z
      .array(z.object({ type: z.enum(["IMAGE", "VIDEO"]), url: z.string().url(), alt_text: z.string().optional() }))
      .min(2)
      .max(10),
    caption: z.string().max(2200).optional(),
    location_id: z.string().optional(),
    collaborators: z.array(z.string()).max(3).optional(),
    publish: z.boolean().default(true),
    wait_seconds: waitSec,
    ig_user_id: igUserId,
  },
  { publishes: true },
  async (a) => {
    const id = await graph.userId(a.ig_user_id);
    const children: string[] = [];
    for (const it of a.items) {
      const c = await graph.request(
        "POST",
        `${id}/media`,
        it.type === "IMAGE"
          ? { image_url: it.url, is_carousel_item: true, alt_text: it.alt_text }
          : { media_type: "VIDEO", video_url: it.url, is_carousel_item: true },
      );
      children.push(c.id);
    }
    for (const c of children) await graph.waitForContainer(c, a.wait_seconds);
    const parent = await graph.request("POST", `${id}/media`, {
      media_type: "CAROUSEL",
      children: children.join(","),
      caption: a.caption,
      location_id: a.location_id,
      collaborators: a.collaborators,
    });
    return finish(id, parent.id, { publish: a.publish, wait: a.wait_seconds, label: "CAROUSEL" });
  },
);

tool(
  "ig_publish_story",
  "PUBLICA una Story (imagen o video, URL HTTPS pública).",
  {
    image_url: z.string().url().optional(),
    video_url: z.string().url().optional(),
    user_tags: userTagsSchema,
    publish: z.boolean().default(true),
    wait_seconds: waitSec,
    ig_user_id: igUserId,
  },
  { publishes: true },
  async (a) => {
    if (!!a.image_url === !!a.video_url) throw new Error("Indicá exactamente uno: image_url o video_url.");
    const id = await graph.userId(a.ig_user_id);
    const c = await graph.request("POST", `${id}/media`, {
      media_type: "STORIES",
      image_url: a.image_url,
      video_url: a.video_url,
      user_tags: a.user_tags,
    });
    return finish(id, c.id, { publish: a.publish, wait: a.wait_seconds, label: "STORIES" });
  },
);

tool(
  "ig_get_container_status",
  "Estado de procesamiento de un contenedor de media (IN_PROGRESS, FINISHED, ERROR, EXPIRED, PUBLISHED).",
  { container_id: z.string() },
  { readOnly: true },
  async ({ container_id }) => graph.containerStatus(container_id),
);

tool(
  "ig_publish_container",
  "PUBLICA un contenedor ya creado (p. ej. con publish=false). Espera a que esté FINISHED.",
  { container_id: z.string(), wait_seconds: waitSec, ig_user_id: igUserId },
  { publishes: true },
  async ({ container_id, wait_seconds, ig_user_id }) => {
    const id = await graph.userId(ig_user_id);
    return finish(id, container_id, { publish: true, wait: wait_seconds, label: "CONTAINER" });
  },
);

// ---------- media ----------
tool(
  "ig_list_media",
  "Lista los posts/reels de la cuenta (paginado).",
  { limit, after, fields, ig_user_id: igUserId },
  { readOnly: true },
  async ({ limit: l, after: af, fields: f, ig_user_id }) => {
    const id = await graph.userId(ig_user_id);
    return graph.request("GET", `${id}/media`, { fields: f ?? MEDIA_FIELDS, limit: l ?? 25, after: af });
  },
);

tool(
  "ig_list_stories",
  "Stories activas (últimas 24h) de la cuenta.",
  { fields, ig_user_id: igUserId },
  { readOnly: true },
  async ({ fields: f, ig_user_id }) => {
    const id = await graph.userId(ig_user_id);
    return graph.request("GET", `${id}/stories`, { fields: f ?? MEDIA_FIELDS });
  },
);

tool(
  "ig_list_live_media",
  "Lives en curso de la cuenta.",
  { fields, ig_user_id: igUserId },
  { readOnly: true },
  async ({ fields: f, ig_user_id }) => {
    const id = await graph.userId(ig_user_id);
    return graph.request("GET", `${id}/live_media`, { fields: f ?? MEDIA_FIELDS });
  },
);

tool(
  "ig_get_media",
  "Detalle de un media (incluye hijos si es carrusel).",
  { media_id: z.string(), fields },
  { readOnly: true },
  async ({ media_id, fields: f }) =>
    graph.request("GET", media_id, { fields: f ?? MEDIA_FIELDS + ",children{id,media_type,media_url,thumbnail_url}" }),
);

tool(
  "ig_set_comments_enabled",
  "Activa o desactiva los comentarios de un media.",
  { media_id: z.string(), enabled: z.boolean() },
  {},
  async ({ media_id, enabled }) => graph.request("POST", media_id, { comment_enabled: enabled }),
);

// ---------- comentarios ----------
const COMMENT_FIELDS = "id,text,username,timestamp,like_count,hidden,parent_id,from";

tool(
  "ig_list_comments",
  "Comentarios de un media.",
  { media_id: z.string(), limit, after, fields },
  { readOnly: true },
  async ({ media_id, limit: l, after: af, fields: f }) =>
    graph.request("GET", `${media_id}/comments`, { fields: f ?? COMMENT_FIELDS, limit: l ?? 25, after: af }),
);

tool(
  "ig_list_replies",
  "Respuestas a un comentario.",
  { comment_id: z.string(), limit, after },
  { readOnly: true },
  async ({ comment_id, limit: l, after: af }) =>
    graph.request("GET", `${comment_id}/replies`, { fields: COMMENT_FIELDS, limit: l ?? 25, after: af }),
);

tool(
  "ig_comment",
  "PUBLICA un comentario nuevo de primer nivel en un media.",
  { media_id: z.string(), message: z.string().min(1).max(2200) },
  { publishes: true },
  async ({ media_id, message }) => graph.request("POST", `${media_id}/comments`, { message }),
);

tool(
  "ig_reply_to_comment",
  "PUBLICA una respuesta pública a un comentario.",
  { comment_id: z.string(), message: z.string().min(1).max(2200) },
  { publishes: true },
  async ({ comment_id, message }) => graph.request("POST", `${comment_id}/replies`, { message }),
);

tool(
  "ig_hide_comment",
  "Oculta o muestra un comentario.",
  { comment_id: z.string(), hide: z.boolean().default(true) },
  {},
  async ({ comment_id, hide }) => graph.request("POST", comment_id, { hide }),
);

tool(
  "ig_delete_comment",
  "ELIMINA un comentario (irreversible).",
  { comment_id: z.string() },
  { destructive: true },
  async ({ comment_id }) => graph.request("DELETE", comment_id),
);

// ---------- insights ----------
tool(
  "ig_media_insights",
  "Métricas de un media. Reels: reach, likes, comments, shares, saved, views, total_interactions, ig_reels_avg_watch_time, ig_reels_video_view_total_time. Posts/carruseles: reach, likes, comments, shares, saved, views, total_interactions. Stories: reach, replies, navigation, shares, views.",
  {
    media_id: z.string(),
    metric: z.string().default("reach,likes,comments,shares,saved,views,total_interactions").describe("Métricas separadas por coma."),
    breakdown: z.string().optional(),
  },
  { readOnly: true },
  async ({ media_id, metric, breakdown }) => graph.request("GET", `${media_id}/insights`, { metric, breakdown }),
);

tool(
  "ig_account_insights",
  "Métricas de la cuenta: reach, views, accounts_engaged, total_interactions, likes, comments, shares, saves, replies, follows_and_unfollows, profile_links_taps, follower_count, online_followers, engaged_audience_demographics, reached_audience_demographics, follower_demographics.",
  {
    metric: z.string().default("reach,views,accounts_engaged,total_interactions"),
    period: z.enum(["day", "week", "days_28", "month", "lifetime"]).default("day"),
    metric_type: z.enum(["time_series", "total_value"]).optional().describe("total_value es necesario para varias métricas y para breakdown."),
    breakdown: z.string().optional().describe("p. ej. media_product_type, follow_type, contact_button_type, age, city, country, gender."),
    timeframe: z.string().optional().describe("Para demografía: last_14_days, last_30_days, last_90_days, prev_month, this_month, this_week."),
    since: z.string().optional().describe("Unix timestamp o fecha YYYY-MM-DD."),
    until: z.string().optional(),
    ig_user_id: igUserId,
  },
  { readOnly: true },
  async ({ ig_user_id, ...q }) => {
    const id = await graph.userId(ig_user_id);
    return graph.request("GET", `${id}/insights`, q);
  },
);

// ---------- descubrimiento ----------
tool(
  "ig_search_hashtag",
  "Obtiene el ID de un hashtag (máx. 30 hashtags únicos por semana). Típicamente requiere Facebook Login.",
  { query: z.string().describe("Hashtag sin #."), ig_user_id: igUserId },
  { readOnly: true },
  async ({ query, ig_user_id }) => {
    const id = await graph.userId(ig_user_id);
    return graph.request("GET", "ig_hashtag_search", { user_id: id, q: query });
  },
);

tool(
  "ig_hashtag_media",
  "Posts top o recientes de un hashtag.",
  {
    hashtag_id: z.string(),
    kind: z.enum(["top_media", "recent_media"]).default("top_media"),
    limit,
    ig_user_id: igUserId,
  },
  { readOnly: true },
  async ({ hashtag_id, kind, limit: l, ig_user_id }) => {
    const id = await graph.userId(ig_user_id);
    return graph.request("GET", `${hashtag_id}/${kind}`, {
      user_id: id,
      limit: l ?? 25,
      fields: "id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count",
    });
  },
);

tool(
  "ig_business_discovery",
  "Datos públicos y posts de OTRA cuenta profesional por username (competencia, referentes).",
  { username: z.string(), media_limit: z.number().int().min(0).max(50).default(10), ig_user_id: igUserId },
  { readOnly: true },
  async ({ username, media_limit, ig_user_id }) => {
    const id = await graph.userId(ig_user_id);
    return graph.request("GET", id, {
      fields: `business_discovery.username(${username}){username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url,media.limit(${media_limit}){id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count}}`,
    });
  },
);

tool(
  "ig_get_tags",
  "Media donde otros usuarios etiquetaron a la cuenta.",
  { limit, after, ig_user_id: igUserId },
  { readOnly: true },
  async ({ limit: l, after: af, ig_user_id }) => {
    const id = await graph.userId(ig_user_id);
    return graph.request("GET", `${id}/tags`, { fields: MEDIA_FIELDS, limit: l ?? 25, after: af });
  },
);

tool(
  "ig_get_mentioned_media",
  "Datos de un media o comentario donde mencionaron a la cuenta (mentioned_media / mentioned_comment). Necesitás el ID del webhook de menciones.",
  { kind: z.enum(["media", "comment"]), id: z.string(), ig_user_id: igUserId },
  { readOnly: true },
  async ({ kind, id: mid, ig_user_id }) => {
    const id = await graph.userId(ig_user_id);
    const edge = kind === "media" ? "mentioned_media" : "mentioned_comment";
    const f = kind === "media" ? "id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count,owner,username" : "id,text,timestamp,like_count,username";
    return graph.request("GET", id, { fields: `${edge}.${kind === "media" ? "media_id" : "comment_id"}(${mid}){${f}}` });
  },
);

// ---------- mensajería ----------
tool(
  "ig_list_conversations",
  "Conversaciones de DM de la cuenta (requiere permiso de mensajería).",
  { limit, after, ig_user_id: igUserId },
  { readOnly: true },
  async ({ limit: l, after: af, ig_user_id }) => {
    const id = await graph.userId(ig_user_id);
    return graph.request("GET", `${id}/conversations`, {
      platform: "instagram",
      fields: "id,updated_time,participants",
      limit: l ?? 20,
      after: af,
    });
  },
);

tool(
  "ig_get_conversation_messages",
  "Mensajes de una conversación.",
  { conversation_id: z.string(), limit },
  { readOnly: true },
  async ({ conversation_id, limit: l }) =>
    graph.request("GET", conversation_id, {
      fields: `messages.limit(${l ?? 20}){id,created_time,from,to,message,attachments}`,
    }),
);

tool(
  "ig_send_message",
  "ENVÍA un DM a un usuario (IGSID) o una private reply a un comentario (comment_id). Sujeto a la ventana de 24h de Meta. Para media usá attachment_type + attachment_url.",
  {
    recipient_id: z.string().optional().describe("IGSID del usuario."),
    comment_id: z.string().optional().describe("Para private reply (1 por comentario, dentro de 7 días)."),
    message: z.string().max(1000).optional(),
    attachment_type: z.enum(["image", "video", "audio"]).optional(),
    attachment_url: z.string().url().optional(),
    ig_user_id: igUserId,
  },
  { publishes: true },
  async (a) => {
    if (!!a.recipient_id === !!a.comment_id) throw new Error("Indicá recipient_id o comment_id (uno solo).");
    if (!a.message && !a.attachment_url) throw new Error("Indicá message o attachment_url.");
    const id = await graph.userId(a.ig_user_id);
    return graph.request("POST", `${id}/messages`, {
      recipient: a.recipient_id ? { id: a.recipient_id } : { comment_id: a.comment_id },
      message: a.attachment_url
        ? { attachment: { type: a.attachment_type ?? "image", payload: { url: a.attachment_url } } }
        : { text: a.message },
    });
  },
);

// ---------- genérico ----------
tool(
  "ig_graph_request",
  "Escape hatch: llama a cualquier endpoint de la Graph API de Instagram (para features no cubiertas). Los métodos POST/DELETE pueden publicar o borrar: usalo con cuidado.",
  {
    method: z.enum(["GET", "POST", "DELETE"]).default("GET"),
    path: z.string().describe("Ruta relativa, p. ej. '17841.../media' o 'me'."),
    params: z.record(z.string(), z.any()).optional(),
  },
  { destructive: true },
  async ({ method, path, params }) => graph.request(method, path, params ?? {}),
);

tool(
  "ig_next_page",
  "Sigue un link `paging.next` devuelto por otra tool (solo del mismo host de la API).",
  { url: z.string().url() },
  { readOnly: true },
  async ({ url }) => graph.getUrl(url),
);

await server.connect(new StdioServerTransport());
console.error("instagram-aitropos MCP listo (stdio)");
