# Pinned local Opus dependency

The unmodified `opusscript-0.1.1/` directory is OpusScript 0.1.1, containing
Emscripten bindings for libopus 1.4. It is loaded locally; no npm install script,
global installation, dependency resolution or runtime download is used.

- Maintainer source: https://github.com/abalabahaha/opusscript/tree/07ae74db7385d6d1be981d929f2f2f2b7e6b8449
- Primary usage/source: https://github.com/abalabahaha/opusscript/blob/07ae74db7385d6d1be981d929f2f2f2b7e6b8449/index.js
- Registry metadata: https://registry.npmjs.org/opusscript/0.1.1
- Downloaded archive: https://registry.npmjs.org/opusscript/-/opusscript-0.1.1.tgz
- Archive SHA256: `019de769ad4a556f2ca874459f3c2c4b6a626a82b39318e2dbf4a494964bdc7a`
- Registry SHA512 integrity: `sha512-mL0fZZOUnXdZ78woRXp18lApwpp0lF5tozJOD1Wut0dgrA9WuQTgSels/CSmFleaAZrJi/nci5KOVtbuxeWoQA==`

The downloaded archive's SHA512 was checked against the exact-version registry
metadata before extraction. `provenance.json` records its SHA256 and the SHA256
of every extracted file. OpusScript's MIT license is in
`opusscript-0.1.1/LICENSE`; libopus's BSD-style notice is in
`opusscript-0.1.1/build/COPYING.libopus`. Both are retained verbatim.

This bridge implements a small compatible wire contract from public Xiaozhi
protocol sources; it does not bundle the Xiaozhi firmware or xinnan backend:

- https://github.com/78/xiaozhi-esp32/blob/main/main/protocols/websocket_protocol.cc
- https://github.com/78/xiaozhi-esp32/blob/main/main/protocols/protocol.cc
- https://github.com/78/xiaozhi-esp32/blob/main/main/audio/audio_service.h

OpenAI native Realtime protocol references:

- https://developers.openai.com/api/docs/guides/realtime-conversations
- https://developers.openai.com/api/reference/resources/realtime/client-events
- https://developers.openai.com/api/docs/guides/realtime-vad
