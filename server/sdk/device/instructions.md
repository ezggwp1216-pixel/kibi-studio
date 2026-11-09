# Kibi development reliability — authoritative addendum

Read the current project's actual board, headers, tools and source hashes before
choosing an API. Read the public device contract and guide at
https://sldvkibi.ru/server/sdk/device/contract.json and
https://sldvkibi.ru/server/docs/HARDWARE.md . Never infer installed symbols merely
from a newer guide. If context.modules is absent, that does not remove confirmed
hardware: inspect the exact public SDK and use its existing interfaces. In a legacy
Wi-Fi/HTTPS snapshot do not invent DeviceWifi or Https::requestJson; preserve the
platform's existing beginWifi/updateWifi and read the actual getJson/postJson
signatures. The reviewed controller family owns retry/target-scan; only ipReady
permits Internet work. Never mix protected headers from different SDK generations.

The platform already initializes display/touch/buttons/battery/power. App Feature::begin
runs BEFORE platform readiness: prepare portable model only. Start hardware work
from the first device Feature::tick or an accepted action after boot. Keep Feature::tick,
input and renderer bounded; network requests and audio belong to an explicitly owned
worker with a bounded queue, copied snapshots, generation cancellation and visible
errors. Native preview never calls real hardware/services.

Microphone exists on both variants. Basic/no-speaker uses the actual MicrophoneI2s
capture plus MicrophonePower::Lifecycle: acquire ownership, create/start MCLK,
80 ms clock preroll, ES7210 initialization within the600ms shared budget; on stop
power down ADC while the clock still exists, then end capture. Read exact signatures.
Speaker variant uses ONE global/internal-RAM DeviceAudio::Session with one worker,
PerformanceLease and bounded monoPCM16/16kHz reads/writes (max256samples, max20ms).
Never run the separate capture owner concurrently or reconfigure Wire/I2S/pins.
preparePlayback, when actually present, raises the amplifier without media/blocking;
keep all initial media samples while a measured nonblocking guard expires. Silence
is valid audio. Mute/cancel/end/error require cleanup and stale-generation rejection.
DMA submission and playing() do NOT prove heard samples or physical completion.
Do not immediately flush the final DMA tail. Never manufacture playback ACK from
write return, server STOP or a timer. Rejected resolution is only valid after
cleanup and negotiation of the exact server feature.

Legacy realtime/job PCM helpers are NOT the standalone server's Opus/v1 protocol.
For /kibi-xiaozhi/v1 read docs/VOICE.md and current hello/features; use the pinned
codec/stack constraints. Server availability does not confer another account's
voice/provider access. New personal cabinets currently have HTTP device transport
and text/Telegram modules, with voice unavailable. Do not build around a promised
multi-user voice API or executable plugin runtime that is not implemented.

Battery is already measured before app tick: under ARDUINO copy
Tamagotchi::StateInfoDetail::runtime.info.{batteryPercent,chargingKnown,charging}
into portable Model. Renderer uses Model; -1 means unknown/stale, show a dash.
Never invent battery%, voltage or charging. The reading is approximate and expires
after30s. CHRG does not prove external USB at full charge. Do not call ADC or
beginStateInfo again. View::Context::online=true in the scaffold is NOT Wi-Fi proof.
Physical plus/minus arrive as InputKind::Plus/Minus after35ms debounce; customize
the existing reducer, not GPIO/ISR. No power GPIO, physical hold/release/autorepeat
is exposed by this input contract. Cancelled touch must not become a tap.

Before readiness: agree the primary action, readable240x296 layout and all screens;
exercise tap/swipe/plus/minus/back plus offline/loading/error/retry/cancel and repeated
start/stop. Preserve public serialization, unknown data and wrap-safe monotonic time.
Source/config/SDK changes invalidate old evidence/artifacts. Inspect real preview
images, then current checks and public target compilation with dummy configuration.
Report source, host, target, device and provider evidence separately. A pass cannot
be inferred from a module being present. Credentials are entered only in Settings;
no raw configured compiler/provider logs, keys, URLs with tokens or user audio in
diagnostics. No paid/provider probe without the user's explicit request.

Optional Kibi Server: use its configured HTTPS panel root, never confuse a device
token with a website password/provider key. Pairing start→display code→cabinet claim→
secret poll→securely persist token; stop at expiry/410. No token in URL/chat/export.
Queue messages are ACKed after idempotent handling. Deduplication lasts only within
the last200 events TOTAL PER ACCOUNT, shared by its devices; it is not indefinite.
USB installation remains the final explicit action for the current verified artifact.
