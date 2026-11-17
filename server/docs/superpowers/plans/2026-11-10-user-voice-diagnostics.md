# Private user voice diagnostics implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give each ordinary user real diagnostics of their own Kibi while the administrator sees service health only.

**Architecture:** Trusted voice principals feed a bounded memory-only collector. Account-bound HTTP/Studio readers return its strict projection; owner status excludes delegated user activity. Existing account, provider and device credentials are unchanged.

**Tech stack:** Node 24, native HTTP/TLS/WebSocket, no runtime npm dependencies, vanilla web UI.

**Spec:** `docs/superpowers/specs/2026-11-10-user-voice-diagnostics-design.md`

## Global constraints

- Account identity comes only from trusted sessions/bearers. Preserve owner data and pilot selection.
- No speech/audio/keys/raw provider errors in diagnostics; memory only, one hour, 32 state events/device, 512 records.
- Russian user copy; existing website palette/Manrope and monochrome Studio are preserved.
- GET/refresh makes no external/provider request or Telegram send. No firmware or driver work in assigned tasks.
- Root controls Git/deployment. Agents change only named files, create no agents and do not touch paused voice implementation.

## Review focus

1. Another account or owner must not retrieve diagnostics by knowing a device ID, including colliding IDs across accounts.
2. Old account/device responses must not survive logout, deletion, revocation or a UI selection change.
3. A late old voice callback must not overwrite a new session; retention and unknown measurements stay truthful.
4. Ordinary data must not leak through owner overview/settings or configuration mutation responses.
5. Packet counters, listener readiness and TLS success must not be labeled as physical audio success.

### Task 1: Collector, observation and owner privacy — root

**Files:** create `src/voice-diagnostics.mjs`, `tests/voice-diagnostics-core.test.mjs`; modify `src/voice.mjs`, `src/xiaozhi/gateway.mjs`, corresponding gateway/delegation tests.

**Produces:** collector API/DTO exactly as spec; `voice.diagnosticsFor(accountId,deviceId)`; private complete status for tenant projection and owner-safe `status()`.

- [ ] Write/run failing tests for trusted principal scoping, duplicate IDs, allowlist, limits/expiry, late callbacks and immutable snapshots.
- [ ] Implement collector and verify focused tests.
- [ ] Test observational gateway callbacks and implement start/status/end/live sampling without lifecycle changes or external calls.
- [ ] Redact owner status when delegated: service-level status/code, `activityVisibility:'service_only'`, `activeSessions:null`, null scope/delegation/studioAccountId, plus `studioVoiceApproved` boolean for configuration UI. Keep complete internal state for delegated user's own status. Test all returning mutation paths and preserve permission/pilot behavior.

### Task 2: Trusted HTTP and Studio routes — assigned API agent

**Files:** `src/server.mjs`, `src/identity.mjs`, new `tests/voice-diagnostics-api.test.mjs`, `docs/API.md`, `docs/VOICE.md`.

**Consumes:** root `owner.voice.diagnosticsFor(accountId,deviceId)` and DTO. **Produces:** tenant facade `diagnosticsFor(deviceId)`, panel and Studio GET endpoints from spec.

- [ ] Write failing HTTP tests for Alice/Bob/owner/no session, foreign/unknown/colliding device IDs, forged owner input and no external side effects.
- [ ] Implement account-bound readers using current trusted dispatcher and `voice.status` Studio scope; recheck authorization after asynchronous account resolution. No client-selected owner; owner endpoint is 403, foreign/missing device 404.
- [ ] Ensure deleted/revoked devices are inaccessible, preserve existing voice operations and document exact DTO/limits/privacy boundary and pre-auth client limitations.
- [ ] Run focused tests; report integration assumptions without touching root voice files.

### Task 3: Personal-cabinet UI — assigned web agent

**Files:** `web/app.js`, `web/index.html`, `web/styles.css`, new focused UI test file if existing test approach supports real behavior.

**Consumes:** the panel GET endpoint/DTO and owner-safe status fields from Tasks 1–2.

- [ ] Implement Russian own-device diagnostics selector, explicit refresh, empty/loading/error state, latest result, real counters and timeline within existing design.
- [ ] Hide/clear diagnostics for owner and unauthenticated views. Fence account/device changes and delayed requests. Do not fabricate unavailable counters.
- [ ] Adapt owner pilot text to `studioVoiceApproved`, without exposing user account/device IDs or activity. Do not alter approval functionality.
- [ ] Verify appropriate JS/UI checks and report controls for root's browser checks. No provider requests or admin login required by feature.

### Task 4: Public local Studio integration — assigned Studio agent

**Files:** `studio/studio-account.mjs`, `studio/studio-account.js`, `studio/studio-account.css`, `studio/studio-platform.mjs`, their existing/new test files, `docs/LOCAL_STUDIO.md`. Do not edit private installed Studio or updater hashes yet; root integrates those after review.

**Consumes:** Studio bearer GET endpoint/DTO from Task 2; existing scopes and safe listDevices.

- [ ] Add strict `deviceDiagnostics({deviceId})` account method, own connector only, no token/model exposure; reject invalid/unknown DTO data.
- [ ] Add read-only `kibi_device_diagnostics` tool and account-dialog diagnostics read for selected own device, with stale account/selection guards and honest unknown states.
- [ ] Test redaction, endpoint/scope use, revoke/switch races, zero provider requests, strict unknown fields and tool context preservation.
- [ ] Update public instructions. Preserve branding/account controls. Report exact changed modules; root updates public updater pins and installed generic modules only.

### Task 5: Integration, review and deployment — root

- [ ] Review each assigned diff against spec and focused evidence; resolve important findings, maintain this plan's ledger.
- [ ] Run full `node --test`; local synthetic HTTP and real browser checks (ordinary, owner, mobile, empty/error, account switch).
- [ ] Review whole branch independently for privacy/auth races. Update public module pins, docs and release package; exclude secrets/data/logs/private firmware.
- [ ] Deploy only verified public server/Studio modules within authorization, preserve data/permissions, check live HTTP/UI and close SSH. Do not claim the physical voice issue fixed by diagnostics alone.
