# instagram-aitropos-mcp

Servidor MCP (stdio) sobre la **API oficial de Instagram (Meta Graph API)**: publicar Reels, fotos, carruseles y stories, gestionar comentarios, ver insights, descubrir hashtags/cuentas y mandar DMs.

## Setup

```bash
npm install && npm run build
cp .env.example .env   # completá IG_ACCESS_TOKEN (y opcionalmente IG_USER_ID)
```

Requisitos de Meta: cuenta de Instagram **profesional** (Business/Creator), app en developers.facebook.com y un token con permisos:
`instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments`, `instagram_business_manage_insights`, `instagram_business_manage_messages` (Instagram Login), o los equivalentes `instagram_basic`, `instagram_content_publish`, … con Facebook Login (poné `IG_API_HOST=https://graph.facebook.com`; hashtags requieren este modo). Mientras la app esté en modo desarrollo solo funciona con cuentas con rol en la app; para otras cuentas se necesita App Review.

## Registrar en Claude Code

```bash
claude mcp add instagram -e IG_ACCESS_TOKEN=... -- node /ruta/a/dist/index.js
```

## Tools

| Área | Tools |
|---|---|
| Cuenta | `ig_get_account`, `ig_get_publishing_limit`, `ig_refresh_token`, `ig_exchange_token` |
| Publicar | `ig_publish_reel` (URL o archivo local, trial reels, colaboradores, portada), `ig_publish_photo`, `ig_publish_carousel`, `ig_publish_story`, `ig_get_container_status`, `ig_publish_container` |
| Media | `ig_list_media`, `ig_list_stories`, `ig_list_live_media`, `ig_get_media`, `ig_set_comments_enabled` |
| Comentarios | `ig_list_comments`, `ig_list_replies`, `ig_comment`, `ig_reply_to_comment`, `ig_hide_comment`, `ig_delete_comment` |
| Insights | `ig_media_insights`, `ig_account_insights` |
| Descubrir | `ig_search_hashtag`, `ig_hashtag_media`, `ig_business_discovery`, `ig_get_tags`, `ig_get_mentioned_media` |
| DMs | `ig_list_conversations`, `ig_get_conversation_messages`, `ig_send_message` (DM y private reply) |
| Otros | `ig_graph_request` (cualquier endpoint), `ig_next_page` |

Las tools que **publican** (reels, posts, comentarios, DMs) actúan de inmediato sobre la cuenta real; los de publicación aceptan `publish: false` para crear solo el contenedor y revisarlo antes.

## Notas de la API

- Límite de 100 publicaciones vía API por cuenta cada 24h (`ig_get_publishing_limit`).
- Los videos por `video_url` deben estar en una URL pública HTTPS; con `file_path` se sube directo (resumable upload).
- Instagram no permite programar posts ni borrar media por API: para programar, usá un scheduler externo que llame a estas tools.
- El token nunca se incluye en los mensajes de error.

## Test

`npm run build && node test/e2e.mjs` — corre el MCP contra una Graph API simulada.
