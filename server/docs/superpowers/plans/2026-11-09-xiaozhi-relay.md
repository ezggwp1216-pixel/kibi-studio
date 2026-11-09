# Xiaozhi Relay Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development with named-file ownership; root integrates and deploys.

**Goal:** Route the personal pilot's existing Kibi firmware through our VPS to a legitimately activated Xiaozhi software client, with no paid fallback.

**Architecture:** Add registration, official WSS transport and a protocol translator behind the existing gateway. Owner configuration is encrypted; authorization remains local and project-scoped.

**Tech Stack:** Node24, existing vendored ws8.22.1/OpusScript0.1.1, built-in crypto/HTTP, existing encrypted store and TLS gateway.

**Spec:** ../specs/2026-11-09-xiaozhi-relay-design.md

## Global Constraints

- No direct application edits, private-data copying, credential logging or silent paid fallback.
- One legitimate VPS software-client identity and one explicit pilot project; no shared anonymous multi-user service.
- Existing V47 downstream profile: Opus, mono16k,60ms, local IDs and exact duration/ACK.
- Preserve TLS, Origin/CSRF, capability revocation and all finite transport limits.

## Review Focus

- Cancellation during START write cannot create orphan STOP/flush.
- Raw late audio cannot cross a retired upstream generation.
- OTA responses cannot introduce arbitrary upstream hosts or expose credentials.
- Unbound/wrong project cannot use the owner's Xiaozhi account.
- Idle status does not imply working cloud speech; real binding/audio must be observed.

## Tasks

1. **Registration module** — create `src/xiaozhi/official-registration.mjs`, `tests/xiaozhi-official-registration.test.mjs`. Export `createOfficialRegistration({read,write,fetchImpl,identityFactory,clock})` with `prepare`, `activate`, `snapshot`, `close`; validate fixed endpoint/schema and private persistence. Tests: legitimate software identity,202pending/200activation,expiredchallenge,WSSallowlist,MQTT-only,failure/cancel/secrecy. Run failing tests first, then implementation and focused checks.
2. **WSS connector** — create `src/xiaozhi/official-socket.mjs`, `tests/xiaozhi-official-socket.test.mjs`. Export `connectOfficialCloud({configuration,signal,onEvent,onClose,WebSocketImpl})` resolving `{hello,sendJson,sendAudio,close}` only after valid hello. Configuration has `url,token,deviceId,clientId`; no API key. Non-hello events use `{binary,payload}`. Validate bounds, strictTLS, timeout, cancellation and exactly-once close; test with injected/real localTLS transports.
3. **Translator** — create `src/xiaozhi/official-adapter.mjs`, `tests/xiaozhi-official-adapter.test.mjs`. Export gateway-compatible `createOfficialXiaozhiAdapter({configuration,sendDevice,connect,createCodec,signal,onStatus})`. Consume task2 transport. Test two turns,24k->16k realOpus,zeroaudio,STARTwrite races,abort retirement,exactACK,longpacedoutput,bounds and deadlines before implementation passes.
4. **Root integration** — modify `src/voice.mjs`, `src/store.mjs`, `src/server.mjs`, `src/xiaozhi/cloud-registry.mjs`, panel/docs and integration tests. Wire encrypted registration, explicit admin endpoints/provider selection and trusted local project identity. Keep old defaults until explicit Xiaozhi selection; no fallback for selected pilot. Add owner setup controls and status without secrets. Reuse current origin/CSRF guards. Run relevant tests then full suite.
5. **Real acceptance** — activate the VPS software client through the user's console, deploy reviewed public Node-only image with rollback, verify private/public TLS, then physical two-turn/long/stop/restart. Publish reviewed source without credentials after verification. Account rejection or transport restriction is a concrete blocker, not a reason to spoof identity or enable paid fallback.
