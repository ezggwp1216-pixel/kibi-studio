# Voice session readiness implementation plan

> **For agentic workers:** Use executing-plans for each bounded task. Root owns integration and deployment; firmware changes are made through the local Studio model.

**Goal:** Make conversation state truthful, support ordinary speaker volume up to 100%, and let Xiaozhi greet first in an explicitly requested session.

**Architecture:** Preserve the existing authenticated gateway and normal TTS/playback-resolution path. Add a negotiated, one-shot greeting request; existing clients continue to use ordinary listen/start. Investigate speaker write failures separately from interface state failures.

**Tech stack:** Node 24 without new runtime dependencies; existing ESP32-S3/Studio application and audio SDK.

## Constraints

- No credentials, personal projects, firmware binaries or raw speech in this repository.
- Preserve tenant ownership, voice grants, provider choice, TLS checks and token storage.
- Preserve half duplex, startup guard 250 ms, logical TX block 256, and six 60 ms prebuffer packets.
- Do not claim physical sound from host tests or a listening server.

## Tasks

- [x] Reproduce the real board termination with numeric-only diagnostics, retaining the first speaker error and measured write timeout/error counters.
- [x] Studio: regression tests for empty/stale Result queues, ordinary phase updates and completed test records; fix the actual hardware tick handler.
- [x] Studio: ordinary volume 5–100% in steps of 5, initial 100%; deliver updates through the single audio owner. Keep diagnostic profile levels separate and preserve nonzero-volume playback continuity.
- [x] Server: advertise `features.session_greeting:true`; accept exact `{type:"greeting",session_id?}` once before normal listening. Send the official short wake request `listen/detect` with fixed `Привет`; never accept arbitrary client text.
- [x] Server: hold input until the normal greeting TTS, STOP and legitimate terminal playback resolution complete, then resume ordinary listening. Reject silent/failed greetings truthfully and bound waiting. Duplicate requests must not retrigger audio.
- [x] Test injected upstream races, cancellation, silent TTS, legacy listening, greeting playback and actual next-turn input. Run `node --test`.
- [x] Update API/voice/Studio integration documentation with the exact additive protocol. Review and deploy only reviewed server changes while preserving runtime data.
- [x] Studio: feature-detect greeting support after hello; request it only after audio initialization. Keep capture closed until the greeting finishes; retain an explicit fallback state on older servers.
- [x] Address speaker write failure only from measured status/partial-write semantics. Never retry an entire block after an SDK call that may have emitted some samples and flushed TX.
- [x] Final Studio check and UI-started server compilation; verify artifact identity and flash the actually connected board without altering its calibration or credentials.
- [ ] Physical verification: initial greeting, two turns, long answer, live volume and clean stop/restart. Report anything still unverified.

## Review focus

1. Duplicate/reentrant requests cannot send a second greeting or reopen an interrupted session.
2. Old clients and OpenAI adapter retain their existing protocol.
3. Empty queues cannot invent idle/error transitions.
4. Volume changes during output cannot reset DMA or reopen microphone capture.
5. Speaker timeout recovery cannot replay, skip or falsely acknowledge samples.

## Current verification

Server: 410 passing tests, zero failures, nine skips; independent review passed. Firmware: 25 independent host checks and 641 native assertions passed; the Studio UI started the successful ESP32 build. Installation hashes were verified. Real audio playback, crackle improvement, and the exact status behind the original speaker error remain subject to physical verification. No full-flash erase or credential/calibration writes were required.
