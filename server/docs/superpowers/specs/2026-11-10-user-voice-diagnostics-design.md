# Private device diagnostics

The user requested technical voice diagnostics in each user's own cabinet and explicitly selected: “В кабинете пользователь видит своё, админ — только состояние службы”. This changes application visibility, not the authority of an operator with root access to a VPS. Existing personal Xiaozhi pilot permissions and owner data must survive.

## Approach

Use the current trusted account/session boundary and a small ephemeral diagnostic collector. A separate admin log viewer would violate the request. Client-only logs cannot explain the server's provider/session decisions. End-to-end encryption against the VPS operator and individual provider accounts are a different project; the user selected cabinet-level isolation.

Ordinary users can select one of their own devices, see observed server stages and fixed error/closure codes, and refresh explicitly. Local Studio can read the same projection using its already granted `voice.status` scope. The administrator receives service configuration/listener health only when an ordinary user's delegated pilot is selected, with no user's activity, counters, account/device selection identifiers or session failure codes.

## Data contract

New collector: `createVoiceDiagnostics({now?})` in `src/voice-diagnostics.mjs`. Methods: `observe({principal,sessionId,event,code,metrics})`, `read(accountId,deviceId)`, `remove(accountId,deviceId)`, `close()`. Principal must be trusted `{kind:'account',accountId,id}` from successful device authorization; no request field chooses its owner. `event` is `start`, `status` or `end`. Ignore owner/legacy principals and late observations from a retired session.

`read` returns exactly `{schemaVersion:'1.0',source:'server',retentionSeconds:3600,observed,updatedAt,connection,metrics,events}`. Empty state has `observed:false`, null time/connection/metrics and an empty event list. Connection is `{state,code,active}`; states are `connecting`, `ready`, `closed`, `error`. Codes are a finite allowlist from the voice gateway. Events are `{at,state,code}`. Metrics permit only bounded integer counters: `inputPackets`, `inputPcmBytes`, `droppedInputPackets`, `outputPackets`, `outputPcmBytes`, `turnsCompleted`, `playbackRejections`. Missing measurements remain null/absent, never invented zeroes. Retain at most 32 state changes per device and 512 device records globally, evict oldest, expire after one hour, clear on process restart. Do not store speech, audio, raw provider payloads, exception messages, response/session IDs, secrets or configuration. Do not write diagnostic records to the event/Telegram feed, disk or console.

Canonical codes: `idle`, `connecting`, `connected`, `ready`, `closed`, `cancelled`, `configuration_required`, `unsupported_endpoint`, `device_protocol_invalid`, `codec_failed`, `input_backpressure`, `output_backpressure`, `authentication_required`, `quota_or_rate_limit`, `provider_error`, `provider_protocol_invalid`, `network_error`, `tls_failed`, `timeout`, `gateway_busy`, `gateway_closed`, `not_found`, `listening`. Map idle/connecting/connected/listening to connecting/active=true, ready to ready/true, closed/cancelled/gateway_closed to closed/false, others to error/false. Only authenticated observations enter the collector; unauthenticated socket failures cannot be attributed to an account. Unknown codes are discarded, never stored as raw text.

Metrics are null or a nonempty partial object of the listed keys, each an integer in `0..Number.MAX_SAFE_INTEGER`; unknown measurements are omitted, with no per-key null or empty object. An observed record requires nonnull canonical ISO updatedAt and connection; its timeline may be empty after individual old transitions expire. A missing record has all three nullable fields null and no events. Every response uses this schema directly, without a wrapper.

Gateway instrumentation must be observational, exception isolated and lifecycle neutral. A trusted callback reports authenticated context start/status/end and sanitized adapter metrics. Sample live counter updates at most once per second, while state changes and final closure are immediate. `startVoiceModule` owns the collector and exposes `diagnosticsFor(accountId,deviceId)`. Tenant voice facades bind account identity and expose `diagnosticsFor(deviceId)`.

## API and UI

- `GET /api/devices/:id/voice-diagnostics`: authenticated ordinary session, own existing device only. Owner returns 403 `user_diagnostics_only`; missing/foreign device returns 404 `device_not_found`.
- `GET /api/studio/devices/:id/voice-diagnostics`: valid Studio bearer with `voice.status`, same own-device membership check. No new credential, scope or provider permission.
- Website places Russian “Диагностика Киби” in the ordinary user's voice/device area, outside owner controls. Show real empty/error/loading states, a selected own device, last update, latest server result, counters and bounded timeline. Clear on logout/account changes; fence delayed responses. Never contact a provider on refresh.
- Local Studio adds a public generic account method and a read-only `kibi_device_diagnostics` tool. It uses the existing private connector internally and returns only the strict DTO. No secrets reach the model. Account dialog can refresh diagnostics for the selected own device. Keep monochrome Studio styling; website keeps the existing brand.

Server observations cannot establish client failures before authentication, microphone quality or physical playback. The UI must state this in context. This version does not add firmware telemetry uploads or pretend the server has USB data. Current physical voice instability remains a separate active debugging task; no new firmware is implied by this website feature.

## Verification and release

Test account/device isolation (including duplicate synthetic device IDs), owner redaction across status and mutations, stale/expired/revoked sessions, deleted devices, strict redaction, collector limits/expiry/stale callbacks, no external calls/Telegram, and UI account-change races. Run `node --test`, local HTTP checks and real browser checks for ordinary/owner/mobile states before deployment claims. Root alone integrates and deploys; no private project, configuration, log or personalized binary enters the public package.
