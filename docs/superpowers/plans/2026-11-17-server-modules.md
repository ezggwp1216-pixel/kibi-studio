# Kibi server modules implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task.

**Goal:** Publish account-owned server modules from Studio and invoke them only from their bound Kibi, with a YouTube-frame example.
**Architecture:** Immutable package registry and revisioned device bindings reuse account and device authentication. Untrusted handlers run only through an optional isolated worker; the YouTube effect uses a separate trusted media adapter.
**Tech Stack:** Node 24, built-in HTTP/crypto/fs, existing vanilla Studio, optional Docker/media worker.
**Spec:** docs/superpowers/specs/2026-11-17-server-modules-design.md

## Global constraints

- Preserve installed Studio 5c82a27e, user projects, credentials and physical board.
- Never execute uploaded source in the HTTP process or via node:vm.
- No credentials/source/raw provider errors in public metadata or logs.
- Keep old scopes unchanged; advertise actual availability and fail closed.
- Node 24, no runtime npm dependencies; external providers are opt-in.

## Review focus

- Cross-account IDs and revoked/deleted devices never authorize execution.
- Concurrent updates use expectedRevision; old work cannot write after disable/rebind.
- Worker failure and oversized output never become successful/synthetic video.
- Old Studio/profile/scopes formats remain usable.
- Persistence errors preserve committed packages and bindings.

### Task 1: Package registry and isolated JavaScript executor

Files: server/src/plugins/{manifest,registry,docker-runtime,runner}.mjs and targeted tests. TDD: reject invalid packages and SHA mismatch; persist immutable versions; bind/update/disable/rollback with revision conflicts; bound worker input/output/time/concurrency and fail closed. Export documented functions for HTTP integration.

### Task 2: Trusted YouTube media adapter and worker

Files: server/src/plugins/youtube.mjs, server/workers/media/**, example .kibiplugin and tests. TDD: strict video IDs/fit, exact RGB565 frame length/hash, timeout/cancellation, fixed safe commands, no URL/shell injection or raw diagnostic output. Document actual dependency and runtime availability. Do not fabricate live-stream success.

### Task 3: Account HTTP integration and grants

Files: server/src/identity.mjs, studio-links.mjs, server.mjs, plugin HTTP service and integration tests. Test legacy grants unchanged, explicit plugin grant, Origin/CSRF, bearer scoping, account/device ownership, publish/list/bind/rollback/invoke and revoked-token rejection using temporary real HTTP accounts and pairing.

### Task 4: Studio integration and UI

Files: studio-integration/src/**, web/**, prompts/** and tests, plus a hash-checked updater into a fresh development copy. Add actual tools and UI; advertise capabilities and disconnected/unavailable states. Test transport validation, races, old scopes, permission failures and truthful readiness. Do not modify installed Studio or copy personal projects/settings.

### Task 5: Whole-path verification and delivery

Run inherited suite and new tests, independent security/compatibility review, local HTTP and browser checks. Produce additive patch/update instructions and evidence report. Leave production deployment and physical board results explicit when access/runtime is unavailable; never publish or flash implicitly.
