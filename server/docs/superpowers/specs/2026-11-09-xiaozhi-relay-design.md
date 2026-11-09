# Kibi Server to Xiaozhi cloud

The user chose Kibi -> our VPS -> official Xiaozhi/Qwen, preserving the Kibi application. They explicitly resumed work on 2026-11-09. This is a personal pilot, not a claim of a free commercial cloud API. Root controls live deployment, account binding and Git publication. Application code remains exclusively owned by the Studio model; this change should work with installed V47 without application edits.

## Chosen approach

Implement a separate official-cloud provider behind the existing local TLS gateway. Direct device-to-Xiaozhi was declined; a direct paid Qwen API does not meet the requested free personal service. Use a distinct, legitimate software-client identity for our VPS, following the officially linked PC client. Never clone the toy's identity, extract factory keys, weaken TLS, or downgrade hardware attestation. Acceptance of the software client by the hosted service is an explicit first integration gate.

One activated VPS software client serves one explicitly selected pilot project at a time. Existing local device capability authentication and revocation stay mandatory. Xiaozhi selection must never fall back to OpenAI. Incoming device messages cannot select upstream credentials or arbitrary URLs. Tokens, software HMAC material, activation proofs and raw OTA replies stay encrypted on the server and outside Git, logs and browser responses. Only the owner sees a temporary six-digit pairing code.

## Components

- Official registration: fixed HTTPS OTA/activate endpoints, persistent software identity, owner-triggered setup, bounded operations and private storage. Console login is not device activation. Support a returned official WSS configuration; report MQTT-only as unsupported rather than inventing credentials.
- Official WSS connector: trusted endpoint allowlist, certificate validation, legitimate identity/token headers, validated hello, bounded messages and cancellation. It receives no OpenAI key.
- Translator: accept the existing Kibi hello/listen/Opus contract and emit its exact session, response/playback IDs, 16k mono60ms audio and duration/ACK controls. Normalize official16/24k mono60ms Opus through the pinned codec. Unsupported formats fail explicitly.
- Server integration/panel: encrypted Xiaozhi configuration, explicit provider/pilot selector, pairing controls and honest status. Keep provider name distinct from an unverified model label. Existing text OpenAI and Telegram functions remain separate.

## Stream contract

Generate local response/playback IDs independently of upstream session IDs. Serialize output; distinguish START queued, sending and written. No STOP/flush may refer to an unseen START. Cancellation while START is being written must wait for that write decision before a matching flush. Zero-audio completion creates no TTS output unless an explicit matching zero-length START/STOP pair is required. Count decoded16k samples, and do not claim to know original upstream encoder padding or acoustic playback.

Keep output512000B/1500messages, input65536B plus bounded packet/event counts,60ms media pacing and finite readiness/write/response deadlines. Initialization after a valid device hello fits the existing15s gateway readiness budget. Invalid/unconfigured requests open no upstream network. Closing/revoking cancels pending connects and writes. Since raw upstream audio lacks response identity, abort retires the upstream channel; no speculative reuse that can admit stale audio. Device ACK confirms local playout only; Xiaozhi history truncation is not invented.

## Acceptance

Synthetic tests cover credentials isolation, no paid fallback,16/24k packet normalization, long responses, successive turns, exact ACK, zero-audio, cancel before/during/after START, stale audio, bounds/timeouts and teardown. Then owner completes real account binding, relay runs on our VPS, and physical Kibi hears two turns plus a long reply and clean stop/restart. Report cloud/account limits honestly if activation is refused. No automatic new paid service or paid OpenAI evaluation.

The existing original checkout's uncommitted RED tests for the old OpenAI unstarted-stop bug are preserved. The isolated worktree starts from committed5bf4383; passing tests there do not claim those unrelated pending tests have been fixed.
