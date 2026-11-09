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
| GET /api/settings | admin | `{telegram:{configured,enabled},ai:{configured,enabled,provider:"openai",model,systemPrompt},voice:{configured,enabled,status,code,model,endpoint,tls,legacyConfigured,legacyReady,activeSessions}}` no keys/chat ID/private paths |
| POST /api/settings/ai | `{apiKey?,model,systemPrompt,enabled}` | `{ok:true,ai:{configured,enabled,provider:"openai",model,systemPrompt},voice:{...safeProfile}}` empty key preserves existing; first setup requires key |
| DELETE /api/settings/ai | none | `{ok:true}` disables and erases stored AI key |
| POST /api/modules/ai/test | `{text}` | `{ok:true,text}` one explicit provider request |
| POST /api/settings/telegram | `{token?,chatId?,enabled}` | `{ok:true,telegram:{configured,enabled}}` empty credentials preserve existing; both required for first setup |
| DELETE /api/settings/telegram | none | `{ok:true}` disables and erases stored credentials |
| POST /api/modules/telegram/test | none | `{ok:true}` or fixed error code; explicit send to the configured chat |
| POST /api/device/events | `{title,message,eventId?}` | `{ok:true,eventId,duplicate:boolean}` |
| GET /api/device/messages | none | `{messages:[{id,title,message,createdAt}]}` |
| POST /api/device/ack | `{messageId}` | `{ok:true}` |
| POST /api/device/chat | `{text}` | `{ok:true,text}` one stateless AI text request |

IDs are opaque. Times are ISO strings or null. Events are newest first, `{id,title,message,deviceId,createdAt,delivery}`; delivery is `local`, `telegram_sent` or `telegram_failed`. Device status is `not_seen`, `online` (last request <=90 seconds) or `offline`. Module rows are `{id,name,status,configured?}`; stable IDs: `notifications` (ready), `ai` and `telegram` (configured/not_configured), `schedules` (planned). `voice` contains the safe voice profile above, with actual disabled/not_configured/listening/connecting/active/error/closed status. No fabricated devices/events on a fresh instance.

Titles 1–120 chars, messages 0–2000 chars, event IDs 1–100 safe ASCII chars. Limit 50 devices, 200 recent events and 50 queued messages per device. A repeated event ID on one device returns the original event and sends no duplicate Telegram message; it must not affect another device's deduplication. Event retention and deduplication are bounded and documented; no promise of indefinite deduplication.

Server export: `createKibiServer({dataDir,adminPassword,publicOrigin,fetchImpl?,webRoot?,voiceConfig?,cookiePath?})` asynchronously returns a standard Node HTTP server. Its `close()` also shuts down the owned voice listener and sessions. `voiceConfig` is trusted process configuration only; HTTP cannot set it. The CLI uses `KIBI_DATA_DIR`, `KIBI_ADMIN_PASSWORD_FILE`, `KIBI_PUBLIC_ORIGIN`, `KIBI_HOST` (default 127.0.0.1), `KIBI_PORT` (default 4391), optional `KIBI_COOKIE_PATH` (default `/`). Node 24, no install-time npm dependencies; pinned voice libraries and licenses are included. Panel HTTPS termination is outside the Node process; cookies use Secure for an https public origin.

Voice is disabled unless `KIBI_VOICE_ENABLED=1` and private matching valid TLS files are configured. Its exact TLS WebSocket path is `/kibi-xiaozhi/v1`; it uses own panel device tokens and encrypted stored OpenAI key with fixed `gpt-realtime`, independent of the text model and text enabled switch. Own-device voice receives the stored `systemPrompt` as bounded trusted server instructions; an empty prompt uses the Russian default. Changing AI configuration cancels the current own-device session. Optional trusted `KIBI_VOICE_LEGACY_DATA_DIR` enables read-only compatibility with existing active Studio capabilities; its fixed schema/default instructions are preserved. See [voice configuration and protocol](VOICE.md). No API route returns an OpenAI key or accepts a filesystem path for voice. A listening gateway does not prove provider access or physical audio.

The first AI provider is OpenAI's fixed `https://api.openai.com/v1/responses` endpoint. Model defaults to `gpt-5-mini`; the configured model must be available to the user's key. Each call sends `{model,instructions:systemPrompt,input:text,store:false,max_output_tokens:1024}` and extracts text from message/output_text items. Input text is limited to 2000 chars, systemPrompt to 4000, model ID to 100 safe ASCII chars and returned text to 4000. There is no retained multi-turn conversation in this version. No arbitrary upstream URLs, automatic test on save, provider error bodies, browser-side API keys or built-in account credentials. A valid form is not proof of provider access; the explicit test uses the user's paid API key. See [official text API documentation](https://developers.openai.com/api/docs/guides/text).

## Xiaozhi pilot

Safe `voice` fields additionally include `provider:"openai"|"xiaozhi"`, `providerLocked:boolean`, `scope:{kind:"legacy"|"panel",id}|null`, `registration:{configured,status,code,pairingCode,expiresAt}`. `model` is `null` for Xiaozhi: the hosted service chooses it in its console. The pairing code is intentionally owner-visible and expires; credentials/challenge/HMAC are never returned.

| Method/path | Owner input | Result |
| --- | --- | --- |
| POST /api/settings/voice | `{provider,scope?}`; Xiaozhi requires one legacy project ID or panel device ID | `{ok:true,voice}`; saves selection, cancels active relay sessions |
| GET /api/settings/xiaozhi | admin | safe registration snapshot; no network |
| POST /api/settings/xiaozhi/prepare | `{}` + Origin/CSRF | `{ok:true,registration,voice}`; explicit fixed official OTA request |
| POST /api/settings/xiaozhi/activate | `{}` + Origin/CSRF | same safe result; one bounded poll then OTA refresh |

One encrypted persistent software client is scoped to one explicitly selected local principal. Incoming device JSON cannot select a provider or upstream credentials. Selected Xiaozhi never falls back to OpenAI, including while unconfigured. Trusted process setting `KIBI_VOICE_PROVIDER=xiaozhi` locks provider selection. OTA and WSS hosts are fixed official allowlists; MQTT-only configurations fail explicitly. Registration makes no network calls during constructor, GET status or panel refresh. External responses and exception text are not returned. Setup network operations run outside the store persistence queue and are rate/deadline/body bounded.

The official Xiaozhi device WebSocket `hello` advertises `features:{playback_ack:true,flush:true,playback_resolution:true}`. A client must feature-detect `playback_resolution:true` before sending this additive control (the OpenAI adapter does not accept it):

```json
{"type":"playback_resolution","state":"rejected","response_id":"…","playback_id":"…"}
```

Only those four fields and optional matching `session_id` are allowed; `audio_end_ms` is forbidden. Send it only after receiving the matching normal `tts/stop` and completing terminal local playback cleanup when full playout cannot be proven, such as mute, text-only playback handling or volume invalidation. It is a rejected terminal resolution, not a playback ACK: it leaves `acknowledgedMs` and any real partial ACK unchanged, reports no heard duration, and performs no cloud history truncation. Full hardware-backed `playback` ACK retains its existing meaning and validation.

The first rejection requires the current noninterrupted response, matching response/playback/session IDs, provider completion and submission of its normal STOP to the device transport. A rejection racing the STOP write callback is recorded but cannot resume upstream listening until that write succeeds. Resume requires completion plus successful STOP write and either full playback ACK or explicit rejected resolution; zero-audio replies still resume automatically without TTS. Bare microphone packets or another `listen/start` do not settle a pending reply. Duplicates of an accepted rejection are idempotent within the bounded last 32 playbacks, never settle a newer response, and do not send another upstream listen. Interrupted, unknown, mismatched, early or first-time stale resolutions close with `device_protocol_invalid`. Safe adapter snapshots add only the numeric `metrics.playbackRejections` counter; no response identifiers, ACK durations or terminal payloads are exposed. See [device voice contract and physical-test limits](VOICE.md).
