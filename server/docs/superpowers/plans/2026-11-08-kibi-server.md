# Kibi Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a branded, self-hostable Kibi Server website, working device/Telegram foundation, AI deployment instructions and public GitHub source.

**Architecture:** Dependency-free Node 24 HTTP server serves a bundled web panel and bounded authenticated API. A private persistent directory contains encrypted settings and device/event state. Docker Compose packages the same application for users' servers; the existing Kibi infrastructure is untouched.

**Tech Stack:** Node 24 built-ins, HTML/CSS/ES modules, Manrope, Docker Compose.

**Spec:** ../specs/2026-11-08-kibi-server-design.md

## Global Constraints

- Brand #202D85 / #FA9442 / #FAF6EF and bundled OFL Manrope.
- No existing Studio projects, credentials, firmware or private server state.
- Actual empty/failed states; voice and schedules stay explicitly planned.
- Admin session + CSRF + fixed origin; per-device hashed tokens; encrypted Telegram credentials.
- Local preview on loopback; public deployments require HTTPS.

## Review Focus

- Unauthenticated/foreign-origin callers must not create devices or reveal configuration.
- Duplicate device events must not duplicate notifications.
- Telegram timeouts/errors must not leak token-containing URLs or lose the local event.
- Persistent data must survive restart and never enter Git or Docker image layers.
- Long labels, narrow screens and keyboard navigation must keep primary actions usable.

### Task 1: Server and modules

**Files:** src/server.mjs, src/store.mjs, src/telegram.mjs, src/module-example.mjs, tests/server.test.mjs.

- [ ] Pin HTTP contract with tests for session/CSRF, devices, events, settings, failures, restart and revocation; run red.
- [ ] Implement bounded Node API, encrypted persistent store and fixed-host Telegram transport; run tests green.

### Task 2: Branded site

**Files:** web/index.html, web/styles.css, web/app.js, web/assets/Manrope.ttf, web/assets/OFL.txt.

- [ ] Build real overview/device/module/instruction flows against the shared API contract.
- [ ] Verify empty/loading/error states and Chrome desktop/narrow keyboard flows.

### Task 3: User deployment

**Files:** package.json, Dockerfile, compose.yaml, compose.https.yaml, Caddyfile, scripts/init.mjs, README.md, START_HERE.md, bootstrap-prompt.txt, docs/MODULES.md, .gitignore, .dockerignore.

- [ ] Provide safe repeatable init preserving credentials and data, documented local and Compose paths.
- [ ] Document API, actual feature status, optional modules, backups/update and AI-assisted installation.
- [ ] Verify initialization, syntax, clean checkout/source allowlist and instructions.

### Task 4: Review and publish

- [ ] Run tests and actual HTTP/browser flows; correct confirmed defects.
- [ ] Independently review source and deployment defaults.
- [ ] Publish this self-contained kit on GitHub and verify files/README at the resulting commit.
