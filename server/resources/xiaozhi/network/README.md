# Trusted Xiaozhi TLS gateway

`src/xiaozhi/gateway.mjs` is a Node-only TLS WebSocket listener around the existing adapter. Construction does not listen or start an OpenAI session.

```js
const gateway = createXiaozhiGateway({
  tls: {key, cert}, // trusted private Node values, never file paths or device JSON
  host: '127.0.0.1', // default; LAN exposure requires an explicit host choice
  port: 0,
  authorize: async ({token}) => {
    // Owning service compares a bounded device capability in constant time,
    // validates the current project/source/configuration, and returns:
    return {configuration, signal}; // or null to deny
  },
  createAdapter, // optional trusted test injection; production default is the real adapter
  onStatus: ({kind, code, metrics}) => { /* fixed codes/counts only */ }
});
const address = await gateway.listen();
// Device endpoint: wss://<explicitly advertised trusted host>:<address.port>/kibi-xiaozhi/v1
await gateway.close();
```

Factory return: `{listen():Promise<address>, address():address|null, close():Promise<void>}`. No public URL/configuration/path/endpoint option exists. The owner supplies trusted key/certificate contents and owns pairing, capability persistence/revocation, current identity and any advertised network host. The gateway performs no filesystem calls, credential lookup, live OpenAI request or USB operation itself. The default adapter may start a real provider session only after an authorized device sends its valid hello.

Only the exact HTTP/1.1 upgrade path `/kibi-xiaozhi/v1` is accepted. TLS >=1.2 is mandatory. Every Origin header is rejected, including empty or `null`; device credentials are strict `Authorization: Bearer <16–256 base64url characters>`, not URL/query/body fields. The authorization callback receives only `{token}` and returns private configuration plus an optional cancellation signal. It owns constant-time token comparison. No arbitrary HTTP routes/files are served; ordinary HTTP over TLS receives fixed 404. Plaintext is never enabled.

Limits: four raw connections, one reserved/active session, global connection token bucket (16 burst / 1.6 per second), 8 KiB headers, 16 KiB client JSON/messages, maximum 32 fragments / 64 buffered chunks per WebSocket message, raw Opus packet maximum 1275 bytes. Input and output queues are serialized and bounded to 32 messages / 65536 bytes including active work. Input rate: 80 messages and 131072 bytes/second with matching burst; output rate: 160 messages/second with matching burst; control frames: 32 burst / 16 per second. Compression is disabled.

Writes await actual `ws.send` completion and TCP/TLS drain when required, with writable/buffered caps and a five-second deadline. This proves local transport completion, not device playback or hearing. Authorization has a five-second deadline; initial adapter/hello readiness is bounded; each adapter receive has a thirty-second deadline. Pings run every fifteen seconds; receive/pong liveness is limited to forty-five seconds. Owner cancellation, device/socket errors, adapter failures and gateway close abort the session, fail queued writes, clear buffers/timers/listeners and close the latest adapter. Late asynchronous adapter construction is retired even after shutdown. A still-unsettled trusted authorize/factory/receive callback keeps the single admission slot blocked rather than allowing unbounded abandoned callback accumulation. Adapter close is awaited for at most one second; default core close actively cancels its own codec/provider operations.

Status callbacks contain only a fixed code and gateway-owned bounded numeric counters. Device/provider text, upstream IDs/errors, authorization values, configuration, PCM/Opus and transcripts never enter status or logs. There is no console logging. Optional STT/text remains user-channel data handled by the core, not a diagnostic field.

## Vendored transport

The `ws-8.22.1` directory comes from the official npm package:

- https://registry.npmjs.org/ws/-/ws-8.22.1.tgz
- Official project/docs: https://github.com/websockets/ws and its `doc/ws.md`
- Archive SHA-256: `a5cdb19c7090b816ffc109b6d928d352aa2bce73e38f73bd9678d484a62d2f75`
- Verified npm SHA-512 integrity: recorded in `provenance.json`.
- MIT license included unchanged.

No package manager/global installation or install script was run. Two documented source guards disable optional unpinned native `bufferutil` and `utf-8-validate` loading. Node built-in/pure JS implementations remain intact. `provenance.json` records the archive pin, patch rationale and SHA-256 for every vendored file. The RFC6455 parser, masking, fragmentation, UTF-8 validation and sender are the mature upstream implementation, not a new custom parser.

## Verification

Scoped command: `node --test tests/xiaozhi-gateway.test.mjs` on authorized localhost-capable host execution. Tests require `/usr/bin/openssl` on macOS/Linux and generate a fresh one-day localhost certificate/key pair in an OS temporary directory. The temporary files are removed immediately after reading the pair; no PEM credentials are bundled. Connections still verify the generated certificate. Tests never read deployment keys or contact OpenAI.

Coverage includes schema round trip and two raw audio frames through a mock adapter, no compression, strict auth/path/Origin/header rejection, single session/four connections, oversized JSON/Opus, fragmented text and interleaved ping, slow serialized input, bounded concurrent output, authorization/liveness deadlines, TLS 1.1/plaintext rejection, owner cancellation, disconnected/pending/late authorization and factory cleanup, and closing during listen. The close-during-listen regression was observed red (a port survived close), then fixed by serializing shutdown with the pending listen promise.

These transport tests use a substituted core adapter. They do not establish a successful OpenAI conversation, hardware Opus interoperability, physical playback, Wi-Fi quality, AEC, public certificate provisioning or usable flashed firmware. The standalone service owns device capability persistence and cancellation; see `docs/VOICE.md` for deployment and integration boundaries.
