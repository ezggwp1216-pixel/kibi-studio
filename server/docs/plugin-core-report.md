# Plugin core implementation evidence — 2026-11-17

## Delivered scope

- `src/plugins/manifest.mjs`: executable v2 validation, exact SHA-256, package/source bounds, explicit capabilities/effect permissions, public scalar settings, no secrets, recursively frozen verified manifests. Existing SDK v1 validation is unchanged; executable upload requires v2.
- `src/plugins/registry.mjs`: tenant-directory registry, source-free metadata, immutable versions, device ownership predicate, serialized compare-and-swap revisions, settings/default validation, bounded rollback history, cancellation leases, private atomic persistence and fail-closed reopening.
- `src/plugins/docker-runtime.mjs`: disabled by default; bounded Docker image inspection determines availability. Fixed networkless, read-only, UID65534 container arguments; no mounts or injected environment; 128MiB memory, 0.5CPU,32PIDs,5-second handler deadline,64KiB input/output and four concurrent invocations across all runtime instances in this process. Deadline/cancellation/output failure kills the client and explicitly removes the generated container name. Uncertain cleanup disables the executor.
- `src/plugins/runner.mjs`: container-only uploaded-source import and allowlisted `onDeviceRequest`, `onDeviceEvent`, `onDeviceMessage` dispatch. Handler contract is `(input, {settings})`.
- `workers/javascript/Dockerfile`: runner image using the same pinned Node24 Debian digest as the server image.

Public package metadata includes `createdAt`, SHA and manifest identity/settings/permissions, never `server` or source. Internal `get(id,version)` returns `{manifest,sha256}` with a deeply frozen manifest. All metadata/binding read DTOs are defensive copies. `lease(deviceId,pluginId)` returns `{binding,signal,assertCurrent}`; update/disable/rollback/close abort old leases, while `assertCurrent` also rechecks live device ownership.

Quotas are32 total immutable version records per tenant,8 versions per plugin ID,16 bindings per device,16 retained rollback revisions,256 persisted device rows,64 pending registry mutations and an8MiB aggregate persisted-state budget. Writes enforce the same aggregate budget as reopening. A tenant directory has one process owner; multi-process writers are unsupported and external changes fail closed.

## TDD and verification

The first targeted run had17 failing behavior tests because the validator, registry and runtime exports did not yet exist. After implementation,17/17 passed. An additional standalone runner test then failed against the one-object handler call; changing to the canonical two-argument call made it pass. A near-budget persistence test reproduced acceptance of a registry too large to reopen; the write budget now rejects that mutation while preserving the committed file.

Final command, using the provided Node24.22.2 executable:

```text
node --test server/tests/plugin-manifest.test.mjs server/tests/plugin-registry.test.mjs server/tests/plugin-runtime.test.mjs
tests20; pass20; fail0; cancelled0; skipped0
```

Coverage includes SHA mismatch, invalid/oversized manifests, secret and permission rejection, immutable versions, safe metadata, persistence/reopening, tenant separation, foreign/deleted devices, stale revision races, rollback bounds, disabling/closing cancellation, setting defaults/unknown keys, symlinks/corrupt hashes/external file changes, quotas, aggregate-state recovery, fixed container arguments, timeout/abort/output cleanup, global concurrency and safe diagnostics.

Docker command tests use an injected child transport and never execute uploaded source on the host or in the API. One fixed, trusted synthetic source fixture runs the standalone runner in a separate Node child solely to verify the handler protocol; this is not evidence of container isolation.

A full inherited `node --test` attempt in the restricted sandbox reached HTTP/TLS tests but failed when local listeners received `listen EPERM 127.0.0.1`. Affected suites included multiuser, plugin-http, Studio HTTP, voice gateway and Xiaozhi socket/relay tests. Root owns the authorized listener-capable full-suite and real local HTTP verification; the sandbox attempt is not an application regression verdict.

## Explicitly unverified

`command -v docker` returned no executable. No real Docker image was built, no container was started and real isolation/resource limits/container removal are unverified. The image digest is aligned with the existing reviewed server Dockerfile, not newly downloaded or run. No external provider, media tool, user package or physical device was invoked.

Production requires building the fixed public runner image and a reviewed isolated execution deployment. Do not mount a Docker socket, account data, provider credentials or host directories into the runner or an ordinary account API container. The in-process global limit applies to one server process; a multi-process broker must provide its own shared limit. Executor capability reporting proves configured Docker/image availability, not physical playback or provider availability.
