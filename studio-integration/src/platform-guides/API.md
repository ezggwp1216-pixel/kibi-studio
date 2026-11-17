# API Kibi Server 0.1

All JSON is UTF-8. Panel mutations require the configured exact `Origin`, the HttpOnly session cookie and `X-CSRF-Token` from `/api/session`. Login and registration require Origin but no prior session. Errors return `{ok:false,code:"fixed_code"}` without exception bodies or secrets. JSON bodies are limited to 16 KiB except assistant profile POST bodies (49152 bytes), the explicit SDK validation wrapper (136 KiB), v2 plugin publication wrappers (264 KiB), binding mutations (40 KiB) and device invoke wrappers (70 KiB). Device routes use `Authorization: Bearer <deviceToken>` and do not use browser sessions. All panel devices, events and integrations are scoped to the authenticated account; HTTP cannot select another owner.

| Method and path | Input | Output |
| --- | --- | --- |
| GET /api/health | none | `{ok:true,name:"kibi-server",version:"0.1.0"}` |
| GET /api/session | cookie if present | `{authenticated:false}` or `{authenticated:true,csrfToken,user}` |
| POST /api/register | `{email,password}` | 201 `{ok:true,csrfToken,user,studioLink}` + session; empty personal cabinet and one-time Studio code |
| POST /api/login | `{email,password}` for users; `{password}` for existing owner | `{ok:true,csrfToken,user}` + HttpOnly SameSite=Strict cookie |
| POST /api/logout | none | `{ok:true}` + expire cookie |
| GET /api/overview | admin | `{server:{status:"ready",version,uptimeSeconds},devices:[],events:[],modules:[]}` |
| POST /api/devices | `{name}` (1–64 chars) | `{device:{id,name,createdAt,lastSeenAt,status},token}` token displayed once |
| DELETE /api/devices/:id | none | `{ok:true}` revokes the token |
| GET /api/devices/:id/voice-diagnostics | ordinary user session, own existing device | direct server diagnostics DTO below; no provider request |
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

## Xiaozhi registrations and personal voice

Safe `voice` fields additionally include `provider:"openai"|"xiaozhi"`, `providerLocked:boolean`, `scope:{kind:"legacy"|"panel",id}|null`, `registration:{configured,status,code,pairingCode,expiresAt}`. `model` is `null` for Xiaozhi: the hosted service chooses it in its console. The expiring pairing code is visible only to the account that owns this registration; credentials/challenge/HMAC are never returned. Personal voice additionally reports `personal:true`; its scope is an own panel device, never a legacy project.

| Method/path | Authentication/input | Result |
| --- | --- | --- |
| POST /api/settings/voice | session + Origin/CSRF; owner `{provider,scope?}`; ordinary user `{provider:"xiaozhi",scope:{kind:"panel",id:<ownDeviceId>}}` | `{ok:true,voice}`; own configured Xiaozhi and a ready TLS service are required for personal device selection |
| GET /api/settings/xiaozhi | current session | own safe registration snapshot; no network |
| POST /api/settings/xiaozhi/prepare | session + Origin/CSRF, `{}` | `{ok:true,registration,voice}`; explicit fixed official OTA request for this account's software client |
| POST /api/settings/xiaozhi/activate | session + Origin/CSRF, `{}` | same safe result; one bounded poll then OTA refresh |
| DELETE /api/settings/xiaozhi | ordinary user session + Origin/CSRF | `{ok:true,voice}`; cancel own sessions/setup and erase own encrypted registration; owner receives 403 `personal_voice_only` |

Each registered user can bind an independent software client to their own official
Xiaozhi agent: obtain a code in the cabinet, add it in the official console, check
binding, then select an own paired device. No official account password is collected.
Registration secrets use the account's own store and encryption key. The owner's
registration, legacy scope and approved shared pilot remain separate and unchanged.
Personal mode is selected before its provider setup request; provider errors do not
fall back to the owner's pilot. Disconnect keeps personal mode selected with no
device, so the next use requires a new personal binding rather than an implicit
pilot or paid OpenAI fallback. Queued stale setup writes cannot restore disconnected
credentials. Device deletion/revocation and personal configuration changes cancel
only the affected account's connection.

The shared TLS listener admits at most four conversations in total, with one per
personal account registration and one for the owner/shared-pilot session key.
A duplicate account connection is rejected without interrupting its existing
conversation. Account status and diagnostics expose only that account's activity.
This is bounded concurrency, not unlimited capacity or proof of provider access.

The owner's encrypted persistent software client is scoped to one explicitly selected local principal. Incoming device JSON cannot select a provider or upstream credentials. Selected Xiaozhi never falls back to OpenAI, including while unconfigured. Trusted process setting `KIBI_VOICE_PROVIDER=xiaozhi` locks provider selection. OTA and WSS hosts are fixed official allowlists; MQTT-only configurations fail explicitly. Registration makes no network calls during constructor, GET status or panel refresh. External responses and exception text are not returned. Setup network operations run outside the store persistence queue and are rate/deadline/body bounded.

The official Xiaozhi device WebSocket `hello` advertises `features:{playback_ack:true,flush:true,playback_resolution:true}`. A client must feature-detect `playback_resolution:true` before sending this additive control (the OpenAI adapter does not accept it):

```json
{"type":"playback_resolution","state":"rejected","response_id":"…","playback_id":"…"}
```

Only those four fields and optional matching `session_id` are allowed; `audio_end_ms` is forbidden. Send it only after receiving the matching normal `tts/stop` and completing terminal local playback cleanup when full playout cannot be proven, such as mute, text-only playback handling or volume invalidation. It is a rejected terminal resolution, not a playback ACK: it leaves `acknowledgedMs` and any real partial ACK unchanged, reports no heard duration, and performs no cloud history truncation. Full hardware-backed `playback` ACK retains its existing meaning and validation.

The first rejection requires the current noninterrupted response, matching response/playback/session IDs, provider completion and submission of its normal STOP to the device transport. A rejection racing the STOP write callback is recorded but cannot resume upstream listening until that write succeeds. Resume requires completion plus successful STOP write and either full playback ACK or explicit rejected resolution; zero-audio replies still resume automatically without TTS. Bare microphone packets or another `listen/start` do not settle a pending reply. Duplicates of an accepted rejection are idempotent within the bounded last 32 playbacks, never settle a newer response, and do not send another upstream listen. Interrupted, unknown, mismatched, early or first-time stale resolutions close with `device_protocol_invalid`. Safe adapter snapshots add only the numeric `metrics.playbackRejections` counter; no response identifiers, ACK durations or terminal payloads are exposed. See [device voice contract and physical-test limits](VOICE.md).

### Optional session greeting

The Xiaozhi adapter additionally advertises `features.session_greeting:true`.
After validating `hello` and preparing its audio owner, a client can send exactly
`{"type":"greeting"}` with an optional matching `session_id`, before its first
ordinary `listen/start`. This requests one real provider greeting through the
official short wake-word operation (`listen/detect`, fixed text `Привет`). No
client text or provider configuration is accepted. Existing clients that send
ordinary `listen/start` retain their behavior; OpenAI does not support this extension.

Keep microphone capture closed while awaiting and playing the greeting. It uses
normal TTS/Opus/STOP and legitimate terminal playback resolution. Only then does
the gateway start upstream listening and the client open its next capture epoch.
Duplicate requests never trigger another greeting; a first request after ordinary
listening is invalid. A silent greeting is `provider_error`; no response has the
existing 90-second deadline. Cancellation fences late replies. Capability support
and an accepted request do not prove audible speech on the board.

### Optional PCM downlink

An official Xiaozhi client may offer `features.pcm_downlink:true` in its initial
`hello`, while its input `audio_params` remain Opus, 16000 Hz, mono, 60 ms. When
selected, the server's `hello` contains both `features.pcm_downlink:true` and
`audio_params:{format:"pcm_s16le",sample_rate:16000,channels:1,frame_duration:60}`.
Each binary output frame is then exactly 1920 bytes of raw little-endian signed
16-bit mono PCM: 960 samples, without a WAV header. It is the already-decoded
upstream audio; the board need not run an Opus decoder during playback.

The offer alone does not authorize larger output in the gateway. Only the
trusted adapter's successfully written selection changes that session's output
limit. Device microphone input stays Opus with the original 1275-byte limit.
No offer, a false offer, and old/OpenAI adapters retain the old Opus downlink.
Firmware must accept that fallback and reject inconsistent selections or
incorrect PCM frame sizes. TTS identities, 60 ms pacing, sample counts,
greeting, cancellation and terminal playback resolution keep their meanings.
The PCM adapter outbox is bounded by 3 MiB and 1500 messages; legacy Opus keeps
512000 bytes. Gateway transport queues retain their existing smaller bounds.

## Accounts and ownership

`user` is `{id,email,createdAt,role:"user"}` for a registered account, or
`{id:"owner",email:null,role:"owner"}` for the existing administrator. Email is
normalized to lowercase; password length is 12–1024 characters. Email delivery,
address verification and password recovery are not configured in this release.
Registration is not proof of control over the address. Failed login returns
`invalid_credentials`; invalid registration `invalid_registration`, unavailable
address `account_unavailable`. No route accepts a role or target account ID.

The existing root state/key remain the owner's. `accounts.json` holds private
salted asynchronous scrypt password hashes. Each new account has an independent
`accounts/<UUID>/state.json` and encryption key. Back up the WHOLE data directory;
do not restore only state without its key. Maximum 128 accounts, 8 sessions/account,
1024 sessions total, 4 concurrent account KDFs plus 4 owner KDFs. Sessions remain
ephemeral for 12 hours and expire on restart. Login/registration share 10 requests
per minute per connection address (forwarded headers are not trusted).

Devices, events, inboxes, AI settings and Telegram credentials are scoped by the
authenticated session or hashed device token. Opaque IDs do not authorize access.
The existing owner voice gateway remains intact. Ordinary users can configure
only their own personal Xiaozhi registration and select an own paired device.
Before personal setup, an unconfigured or eligible shared-pilot profile may still
be returned; it is not authority over the owner's registration. Ordinary users
cannot configure the owner's provider, legacy scope or other accounts. The
owner-approved Studio pilot below remains a separate revocable permission and is
not required for a user's own Xiaozhi. Profiles, registration and device identity
are resolved from the trusted session/token, never a request-supplied account ID.
This is application data isolation, not an untrusted-code execution boundary.

## One-time device pairing

| Method/path | Input | Result |
| --- | --- | --- |
| POST /api/pairing/start | device `{name}`; no prior token | 201 `{pairingId,code,pollToken,expiresAt,intervalSeconds:3}` |
| POST /api/pairing/claim | session + Origin + CSRF, `{code}` | `{ok:true,device}`; NEVER a device token |
| POST /api/pairing/poll | device `{pairingId,pollToken}` | `{status:"pending",expiresAt}` or once `{status:"paired",device,token,apiBase}` |

Device code is eight characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, formatted
`XXXX-XXXX`. Claim accepts case-insensitive input with spaces/hyphen removed.
The visible code is not the secret poll credential. Both are stored only as hashes
while pending. After claim only the device that holds the random 256-bit poll
credential can collect the new token. The token's hash is already persisted in
the claiming account. The temporary delivery value exists only in process memory.
The configured `apiBase` includes the panel prefix, e.g. `https://host/server/`;
it is never derived from an untrusted Host header.

Pending entries expire after 5 minutes, maximum 64. Restart discards waiting
pairings, not registered devices. Start is limited to 5/minute/address, poll
120/minute/address, claim 20/minute/account. Unknown/expired/wrong-secret poll
returns 410 `pairing_not_found`; malformed claim 400 `pairing_invalid_code`, already
claimed 409 `pairing_claimed`. Claiming is atomic. A collected token cannot be
collected again. If delivery is lost, delete that device in the cabinet and pair
again; the server cannot reconstruct a token from its persisted hash. Device HTTP
authentication has a bounded hash index and 2000/minute/address admission limit.

Firmware must implement this protocol, TLS validation and safe token storage.
The existing voice firmware is not automatically modified by registration or
pairing support on the website. See [local Studio instructions](LOCAL_STUDIO.md).

## Studio account connection

Registration returns `studioLink:{code,expiresAt}`. This is an independent,
single-use code with a 10-minute lifetime, not a password or device credential.
If code persistence fails after registration, registration still succeeds with
`studioLink:{code:null,error:"studio_link_unavailable"}`. The user can retry from
the cabinet. Login never generates a code automatically.

| Method/path | Authentication/input | Output |
| --- | --- | --- |
| POST /api/studio/link-code | ordinary user session + Origin/CSRF, `{}` | 201 `{code,expiresAt}`; invalidates previous unredeemed code |
| GET /api/studio/connections | ordinary user session | `{connections:[{id,label,createdAt,expiresAt,scopes}]}` |
| DELETE /api/studio/connections/:id | same session + Origin/CSRF | `{ok:true}`; own connections only |
| POST /api/studio/redeem | no cookie authority; `{code,label}` | 201 `{token,connection,account,apiBase,scopes}`; code consumed once |
| GET /api/studio/profile | Studio bearer | `{account,connection,scopes,voice,voiceEligibility}` |
| GET /api/studio/devices | Studio bearer | `{devices}`; safe own devices only |
| GET /api/studio/devices/:id/voice-diagnostics | Studio bearer with existing `voice.status`, own existing device | same direct server diagnostics DTO as the cabinet |
| POST /api/studio/pairing/claim | Studio bearer, `{code}` | `{ok:true,device}`; no device token |
| POST /api/studio/voice/activate | Studio bearer with `voice.activate`, `{deviceId}` | `{ok:true,voice}`; select an own device for configured personal Xiaozhi; shared pilot separately requires owner approval |
| DELETE /api/studio/session | Studio bearer | `{ok:true}`; revokes only this connection |

Bearer routes accept an absent Origin for the local server-to-server client.
If Origin is supplied it must exactly match the configured public origin. Browser
cookies do not authorize bearer routes; a Studio token cannot authorize panel
settings. New connections receive seven scopes: `pairing.claim`, `devices.list`,
`voice.status`, `voice.activate`, `catalog.read`, `assistant.read`, `assistant.write`.
Existing five-scope connections retain exactly their original rights; create and
redeem a fresh link code for assistant access. Missing assistant scope returns
403 `studio_scope_denied`; there is no silent privilege upgrade.
Tokens expire absolutely after 90 days, with no
automatic renewal; maximum eight connections per account. Only code/token hashes
are persisted on the server. Studio keeps its dedicated token in its private
local file with mode 0600; tokens are never sent to the model or embedded in
firmware. Revoking a Studio connection does not revoke the independently paired
device; delete that device to revoke its own credential.

## Assistant profile and built-in actions

| Method/path | Authentication/input | Result |
| --- | --- | --- |
| GET /api/devices/:id/assistant | ordinary user session, own existing device | direct assistant profile DTO below |
| POST /api/devices/:id/assistant | same session + Origin/CSRF, exact `{character,context,actions}` | updated direct DTO; request body at most 49152 UTF-8 bytes |
| GET /api/studio/devices/:id/assistant | Studio bearer with `assistant.read`, own existing device | same direct DTO |
| POST /api/studio/devices/:id/assistant | Studio bearer with `assistant.write`, exact `{character,context,actions}` | same update and body bound |

The DTO is `{deviceId,revision,character,context,actions,rolePrompt,application,
catalog}`, without an `ok` wrapper. `character` is at most 4000 characters,
`context` at most 6000; both may be empty. `actions` is a unique subset of
`["kibi.get_device_status","kibi.notify"]`; no extra keys or executable source are
accepted. `catalog` contains `{id,title,description}` for these two built-in actions.
An unsaved profile has `revision:0`; each successful save increments it. Profiles
are encrypted in that account's store. Foreign/deleted devices return 404
`device_not_found`; owner session routes return 403 `user_assistant_only`.
Invalid input is 400 `assistant_invalid_profile`, unavailable/corrupt storage
503 `assistant_unavailable`; profile/revision limits return 409 fixed codes.
No body or URL can select another account. Studio bearer and browser cookie
permissions remain distinct; supplied bearer-route Origin must match exactly.

`application` is exactly `{mode:"manual_xiaozhi",status:"manual_step_required"}`.
`rolePrompt` is text for the user to paste into their own official Xiaozhi agent,
once initially and again after changing character. Saving or copying it does not
apply a cloud system instruction. The server does not use an undocumented console
role API. Profiles persist; automatic conversation memory/history does not exist.

A personal connection can advertise `features.mcp:true` in its **upstream**
official hello only when a trusted account/device-bound handler is attached.
`initialize` (protocol `2024-11-05`), `tools/list`, `tools/call` and `ping` are
handled on the server; cloud messages cannot choose another account or device.
`kibi.get_context` is always listed and returns current `{revision,character,context}`
as tool data, not a system instruction. Whether the cloud actually requests or
uses those data is not established by profile save or MCP advertisement.
The two optional actions are rechecked against the current saved permissions:

- `kibi.get_device_status({})`: only `{id,name,status,lastSeenAt}` saved for the
  authenticated device; no battery, physical power or invented telemetry.
- `kibi.notify({title,message})`: title 1–120 characters, message 0–2000; enqueue
  in that device's existing message queue and return `{queued:true}`. This does
  not prove delivery/display and sends no automatic Telegram message.

Volume, brightness, faces and timers are not implemented assistant tools. No
arbitrary URLs, scripts, imports or user-code execution are offered. MCP requests
are bounded to 16 KiB with a five-second operation budget; duplicate request IDs
are retained in a bounded 32-entry session cache, not a permanent deduplication
promise. The separate `.kibiplugin` validator remains nonexecuting.

## Private device voice diagnostics

Both diagnostics GET routes return the following exact schema directly, without
an `ok` or `diagnostics` wrapper. An existing device without a recent authenticated
server observation returns 200 with this truthful empty state, including when
voice is unavailable:

```json
{"schemaVersion":"1.0","source":"server","retentionSeconds":3600,"observed":false,"updatedAt":null,"connection":null,"metrics":null,"events":[]}
```

For `observed:true`, `updatedAt` is a canonical ISO timestamp and `connection` is
`{state,code,active}`. States are `connecting`, `ready`, `closed`, `error`.
`metrics` is null or a nonempty partial object containing only safe integer
counters in `0..Number.MAX_SAFE_INTEGER`: `inputPackets`, `inputPcmBytes`,
`droppedInputPackets`, `outputPackets`, `outputPcmBytes`, `turnsCompleted`,
`playbackRejections`. Unmeasured counters are absent, never invented zeroes or
per-key nulls. `events` contains at most 32 `{at,state,code}` state transitions;
`at` is a canonical ISO timestamp. It may be empty after older transitions expire.

Allowed codes are `idle`, `connecting`, `connected`, `ready`, `closed`,
`cancelled`, `configuration_required`, `unsupported_endpoint`,
`device_protocol_invalid`, `codec_failed`, `input_backpressure`,
`output_backpressure`, `authentication_required`, `quota_or_rate_limit`,
`provider_error`, `provider_protocol_invalid`, `network_error`, `tls_failed`,
`timeout`, `gateway_busy`, `gateway_closed`, `not_found`, `listening`.
`idle`/`connecting`/`connected`/`listening` map to `connecting` with `active:true`;
`ready` maps to `ready` with `active:true`;
`closed`/`cancelled`/`gateway_closed` map to `closed` with `active:false`;
all other allowed codes map to `error` with `active:false`.

Identity comes only from the trusted ordinary session or scoped Studio bearer.
Query parameters, request bodies and device IDs cannot select another account.
The panel endpoint returns 403 `user_diagnostics_only` for the owner and 401
`unauthorized` without a current ordinary session. The Studio endpoint requires
its bearer even if a panel cookie is present; invalid, expired or revoked bearer
returns 401 `studio_unauthorized`. Both endpoints check current device membership
after asynchronous account resolution: unknown, foreign and deleted/revoked
devices return 404 `device_not_found`. Duplicate IDs in different accounts remain
separate. These reads grant no voice activation or provider permission. Responses
use `Cache-Control: no-store`; refresh performs no external request or Telegram send.

Records exist only in memory: one-hour retention, at most 512 device records
globally with oldest-record eviction, cleared on process restart. Live counter
updates are sampled at most once a second; state changes and final closure are
immediate. No speech, audio, raw provider payloads, exception messages, session or
response IDs, secrets, settings or private paths are returned or written to disk,
console or the event/Telegram feed by diagnostics.

The ordinary user sees only their own observations. When an ordinary user's
delegated pilot is selected, owner voice profiles expose service state only:
`activityVisibility:"service_only"`, `activeSessions:null`, null
`scope`/`delegation`/`studioAccountId`, and `studioVoiceApproved` as a boolean.
They reveal no user's activity, counters or session failure codes. This is cabinet
access isolation; it does not prevent a VPS operator with root access from
inspecting the running server. Server observations cannot establish failures
before device authentication, microphone quality or physical playback, and do
not imply firmware telemetry or USB access. See [voice limitations](VOICE.md).

## Shared Xiaozhi pilot permission

Owner POST `/api/settings/voice/studio-account` with `{email}` plus session,
Origin and CSRF approves one existing ordinary account; DELETE removes approval.
Approval alone admits no voice connection. The account must pair its own device
and explicitly activate it. Eligibility is `{approved,canActivate,code}`, also
available in `voice.studioVoice`; `canActivate` requires configured Xiaozhi and an
open gateway. Provider changes cannot be made by a user or Studio token. This
shared pilot remains limited to one approved account, one selected device and one
active owner/pilot conversation. Independent personal registrations use the common
four-conversation server bound; they do not inherit the pilot's credentials.

Owner POST `/api/settings/voice/delegation` with `{email,deviceId}` explicitly
selects an existing device; DELETE restores the previously selected owner/legacy
scope. Studio activation creates a managed grant. Changing/revoking account
approval removes only managed grants, preserving independently created manual
grants. Device deletion, credential revocation or failed committed authorization
closes its session. Shared-pilot profiles omit owner credentials, owner registration
codes and other users' activity; a personal registration's safe temporary code is
visible only in its own cabinet. No operation silently falls back to paid OpenAI.

## SDK 1.0

`GET /api/sdk` returns `{version:"1.0",deviceContract:"1.0",supportRelease:"2026-11-18-r4",validation:true,execution:false,links}`.
Public links include hardware/service instructions, the device contract and a
SHA-256-pinned SDK support kit. Its updater touches only known public SDK paths;
it neither reads private projects/configuration nor flashes a device.
`POST /api/sdk/validate` requires session/Origin/CSRF and
`{package:<JSON object or JSON text>}` up to a 136 KiB HTTP wrapper; the package
itself is limited to 128 KiB. Response is
`{ok:true,valid,errors:[{path,code}],requiresRuntime,runtimeSupported:false}`.
It never returns the manifest/source, installs anything, executes JavaScript or
contacts a provider. Invalid structure is a successful validation operation with
`valid:false`. SDK source, schema, two examples and public instructions are served
only from explicit allowlisted paths. See [SDK contract](SDK.md).


## Server modules v2

The SDK 1.0 validator above remains nonexecuting. Its `execution:false` and
`runtimeSupported:false` do not describe the separate v2 runtime. Executable
packages use `manifestVersion:2`, `sdkVersion:"1.1"`, `secrets:[]`; the exact
package, handler and effect contracts are in [SERVER_MODULES.md](SERVER_MODULES.md).
Support release `2026-11-18-r4` includes the current public guides; its
`contractRelease:"2026-11-17-r3"` identifies unchanged hardware/overlay payloads.
The immutable r3 support archive remains separate.

An ordinary account issues a new code with `POST /api/studio/link-code`, session,
Origin/CSRF and `{plugins:true}`. On `POST /api/studio/redeem`, the updated Studio
must additionally send `X-Kibi-Studio-Protocol: plugins-v1`. Only explicit approval
plus this negotiation grants `plugins.read`, `plugins.publish`, `plugins.bind`.
Existing five/seven-scope connections keep their exact scopes. A protocol header
alone cannot upgrade a connection. Codes/tokens never go into chat or firmware.

| Method/path | Authentication/input | Response |
| --- | --- | --- |
| GET /api/studio/plugins | Studio bearer, `plugins.read` | `{capabilities,plugins:[metadata]}` |
| POST /api/studio/plugins | Studio bearer, `plugins.publish`; `{packageText,sha256}` | 201 `{plugin:metadata}` |
| GET /api/studio/devices/:deviceId/plugins | Studio bearer, `plugins.read`, own device | `{bindings:[binding]}` |
| POST /api/studio/devices/:deviceId/plugins/:pluginId | Studio bearer, `plugins.bind`; `{version,expectedRevision,enabled,settings}` | `{binding}` |
| POST /api/studio/devices/:deviceId/plugins/:pluginId/rollback | Studio bearer, `plugins.bind`; `{toRevision,expectedRevision}` | `{binding}` |
| POST /api/device/plugins/:pluginId/invoke | Own device bearer; `{input:<JSON object>}` | `{ok:true,result}` or the frame below |

Panel routes use the same paths without `/studio`: `/api/plugins` and
`/api/devices/:deviceId/plugins…`. They require an ordinary user session, with
exact Origin and CSRF for mutations; the owner receives `user_plugins_only`.
Studio bearer, panel cookie and device bearer are separate credentials. Trusted
sessions/tokens choose the account; no request-supplied owner ID is accepted.
Foreign/deleted devices return `device_not_found`.

`metadata` is `{id,version,name,description,sha256,createdAt}` without source.
`binding` is `{pluginId,version,revision,enabled,settings,updatedAt}`.
`capabilities` is `{protocol:1,publish:true,bind:true,rollback:true,
runtime:{configured,available},media:{configured,available}}` with actual booleans.
Availability is an observation, not proof of a successful invocation or provider frame.

`packageText` is the exact UTF-8 JSON text, at most 128 KiB; `sha256` is its lowercase
64-hex digest. The trusted Studio host computes it for
`kibi_publish_server_module({packageText})`. Source is at most 64 KiB. Versions are
immutable. Binding `expectedRevision` is 0 initially, then the current revision;
conflicts return `plugin_revision_conflict`. Rollback restores the recorded
version/settings/enabled state as a new revision, never firmware. Changing or
disabling a binding, device revocation and request cancellation fence old work.
Publishing/enabling does not schedule or run a handler. The device explicitly
invokes it; its own token is obtained and stored by the device, never supplied by Studio.

Invoke input and handler JSON result are limited to 64 KiB; handler execution is
bounded to five seconds, four whole invocations per HTTP process and one per
account/device/module. Uploaded JavaScript never executes in the HTTP process;
an isolated broker/runtime is configured separately. No arbitrary network or
integration keys are exposed to JavaScript. User-module secrets and schedules
are not implemented. Notification results return `{ok:true,result:{queued:N}}`;
queuing is not evidence of device delivery.

A YouTube frame returns 142080 bytes with `Content-Type: application/octet-stream`,
`X-Width:240`, `X-Height:296`, `X-Pixel-Format:rgb565le`, lowercase
`X-Content-SHA256` and `X-Binding-Revision`. Validate exact size, dimensions, format,
current revision and SHA-256 before display. Fixed failures use `{ok:false,code}`;
examples include `plugin_runtime_unavailable`, `plugin_runtime_timeout`,
`plugin_runtime_failed`, `plugin_media_unavailable`, and HTTP 424
`plugin_media_provider_restricted`. A provider restriction is an unsuccessful frame
check; do not bypass it with cookies, login, proxies or another person's keys.
Do not report video, sound, Docker/media readiness or physical playback from package
validation, compilation or a capability response. See
[deployment and recovery](SERVER_MODULES_DEPLOY.md) and [media limits](YOUTUBE_MODULE.md).
