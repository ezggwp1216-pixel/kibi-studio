# API Kibi Server 0.1

All JSON is UTF-8. Mutations in the admin panel require the configured exact `Origin`, the HttpOnly session cookie and `X-CSRF-Token` from `/api/session`. Login requires Origin but no prior session. Errors return `{ok:false,code:"fixed_code"}` without exception bodies or secrets. JSON bodies are limited to 16 KiB. Device routes use `Authorization: Bearer <deviceToken>` and do not use browser sessions.

| Method and path | Input | Output |
| --- | --- | --- |
| GET /api/health | none | `{ok:true,name:"kibi-server",version:"0.1.0"}` |
| GET /api/session | cookie if present | `{authenticated:false}` or `{authenticated:true,csrfToken}` |
| POST /api/login | `{password}` | `{ok:true,csrfToken}` + HttpOnly SameSite=Strict cookie |
| POST /api/logout | none | `{ok:true}` + expire cookie |
| GET /api/overview | admin | `{server:{status:"ready",version,uptimeSeconds},devices:[],events:[],modules:[]}` |
| POST /api/devices | `{name}` (1–64 chars) | `{device:{id,name,createdAt,lastSeenAt,status},token}` token displayed once |
| DELETE /api/devices/:id | none | `{ok:true}` revokes the token |
| POST /api/devices/:id/messages | `{title,message}` | `{ok:true,messageId}` |
| POST /api/events | `{title,message}` | `{ok:true,event}` local test event; may notify Telegram only when enabled |
| GET /api/settings | admin | `{telegram:{configured,enabled},ai:{configured,enabled,provider:"openai",model,systemPrompt}}` no keys/chat ID |
| POST /api/settings/ai | `{apiKey?,model,systemPrompt,enabled}` | `{ok:true,ai:{configured,enabled,provider:"openai",model,systemPrompt}}` empty key preserves existing; first setup requires key |
| DELETE /api/settings/ai | none | `{ok:true}` disables and erases stored AI key |
| POST /api/modules/ai/test | `{text}` | `{ok:true,text}` one explicit provider request |
| POST /api/settings/telegram | `{token?,chatId?,enabled}` | `{ok:true,telegram:{configured,enabled}}` empty credentials preserve existing; both required for first setup |
| DELETE /api/settings/telegram | none | `{ok:true}` disables and erases stored credentials |
| POST /api/modules/telegram/test | none | `{ok:true}` or fixed error code; explicit send to the configured chat |
| POST /api/device/events | `{title,message,eventId?}` | `{ok:true,eventId,duplicate:boolean}` |
| GET /api/device/messages | none | `{messages:[{id,title,message,createdAt}]}` |
| POST /api/device/ack | `{messageId}` | `{ok:true}` |
| POST /api/device/chat | `{text}` | `{ok:true,text}` one stateless AI text request |

IDs are opaque. Times are ISO strings or null. Events are newest first, `{id,title,message,deviceId,createdAt,delivery}`; delivery is `local`, `telegram_sent` or `telegram_failed`. Device status is `not_seen`, `online` (last request <=90 seconds) or `offline`. Module rows are `{id,name,status,configured?}`; stable IDs: `notifications` (ready), `ai` and `telegram` (configured/not_configured), `voice` and `schedules` (planned). No fabricated devices/events on a fresh instance.

Titles 1–120 chars, messages 0–2000 chars, event IDs 1–100 safe ASCII chars. Limit 50 devices, 200 recent events and 50 queued messages per device. A repeated event ID on one device returns the original event and sends no duplicate Telegram message; it must not affect another device's deduplication. Event retention and deduplication are bounded and documented; no promise of indefinite deduplication.

Server export: `createKibiServer({dataDir,adminPassword,publicOrigin,fetchImpl?,webRoot?})` asynchronously returns a standard Node HTTP server. The CLI uses `KIBI_DATA_DIR`, `KIBI_ADMIN_PASSWORD_FILE`, `KIBI_PUBLIC_ORIGIN`, `KIBI_HOST` (default 127.0.0.1), `KIBI_PORT` (default 4391). Node 24, no install-time npm dependencies. HTTPS termination is outside the Node process; cookies use Secure for an https public origin.

The first AI provider is OpenAI's fixed `https://api.openai.com/v1/responses` endpoint. Model defaults to `gpt-5-mini`; the configured model must be available to the user's key. Each call sends `{model,instructions:systemPrompt,input:text,store:false,max_output_tokens:1024}` and extracts text from message/output_text items. Input text is limited to 2000 chars, systemPrompt to 4000, model ID to 100 safe ASCII chars and returned text to 4000. There is no retained multi-turn conversation in this version. No arbitrary upstream URLs, automatic test on save, provider error bodies, browser-side API keys or built-in account credentials. A valid form is not proof of provider access; the explicit test uses the user's paid API key. See [official text API documentation](https://developers.openai.com/api/docs/guides/text).
