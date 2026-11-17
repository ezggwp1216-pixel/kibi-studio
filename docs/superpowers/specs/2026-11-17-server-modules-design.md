# Server modules published from Kibi Studio

The user approved creating, publishing, binding, running, stopping, updating and rolling back server modules during application development. YouTube live frames are the first example. Existing Studio, user projects, accounts, voice and board firmware must be preserved. Work is isolated from Studio 5c82a27e; the user explicitly approved backend source 4a75f3edd6fba787da865caa6536fa5aa01cf583.

## Architecture and decisions

Use the existing Studio account and independent paired-device credentials. Add a versioned plugin API with account-owned immutable packages, SHA-256, device bindings and revision conflicts. Old Studio connections retain their original scopes. New plugin-enabled links explicitly negotiate the added plugin scopes. Missing worker support is an honest unavailable state.

Never evaluate uploaded JavaScript in the HTTP process. An optional Docker execution adapter runs one bounded request in a read-only, networkless, unprivileged container, with no user-data mounts, host environment, secrets or Docker socket inside it. A dedicated broker may own Docker; the main account service must not need the socket. Fail closed without an available isolated executor. Uploaded source is at most 64 KiB, a package at most 128 KiB, input/output at most 64 KiB, a handler has a 5-second deadline, with at most four concurrent invocations globally and one per account/device/module. Cancellation and device revocation invalidate late results.

Manifest v1 remains a structural format; do not silently redefine its validation result. Add a v2 executable manifest for request/event/message handlers, ordinary public settings and explicit effect permissions. Handler code returns typed effect descriptions. The first media effect is youtubeFrame, permission media:youtube-frame. Only an eleven-character YouTube video ID and contain/cover fit are accepted; no arbitrary URL is supplied to a shell or HTTP fetch.

A trusted opt-in media worker obtains the public YouTube stream and converts it to bounded 240x296 RGB565 frames using separately managed media tools. Its deployment has no cabinet/Studio/provider credentials. No source, upstream URL, raw tool output or exceptions are returned through public status. A missing media worker reports unavailable; synthetic frames are test fixtures, never presented as a real live stream.

## Integration contract

`GET /api/studio/plugins` returns capabilities and owned package metadata. `POST /api/studio/plugins` accepts `{packageText,sha256}`. `GET /api/studio/devices/:deviceId/plugins` lists own bindings. `POST .../:pluginId` accepts `{version,expectedRevision,enabled,settings}`. `POST .../:pluginId/rollback` accepts `{toRevision,expectedRevision}`. `POST /api/device/plugins/:pluginId/invoke` accepts `{input}` and authenticates the actual device token. Frame effect responses are bounded binary RGB565 with dimensions/hash headers. Account identity always comes from verified sessions/bearers, never request JSON. Matching panel routes use cookie+Origin+CSRF. A binding revision changes on enable/disable/update/rollback and cancellation fences prior work.

Studio gains bounded named tools and account UI to publish, list, assign, disable and roll back. It surfaces disconnected, insufficient permission, unsupported server, unavailable runtime and conflict states. Source packages remain public project artifacts; credentials never enter model context or package source. The YouTube example is full-screen and initially silent, with visible connecting/offline/error/retry/stop states.

## Verification and release

Test registry persistence, immutable versions, SHA mismatch, ownership, foreign devices, malformed/oversized input, scopes compatibility, cancellation, revision races, runtime timeout/output and disabled-worker failure. Test real local HTTP with temporary accounts and simulated pairing, plus Studio UI against a local server. Run the full inherited Node suite. Docker/media execution and physical playback have separate evidence; do not claim them from stubbed transports. Production deployment requires the actual hosted source and access, a reviewed additive release and rollback; the older public branch must never replace a newer live deployment wholesale.
