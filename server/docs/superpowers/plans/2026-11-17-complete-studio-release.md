# Complete Studio release repair plan

> **For agentic workers:** Use the current-session implementation workflow. Root integrates and publishes; assigned agents change only their named files and do not create agents.

**Goal:** Make the publicly downloadable full Studio package carry the current reviewed public platform/SDK cohort so a new user can test a project without a previous private installation.

**Architecture:** Start only from immutable public GitHub commit `43d47afb090c9bf6ab69ea46ee559da3c9867616` and its SHA-verified ZIP. Review and migrate its explicit public program/template paths into the existing platform contracts, then build a reproducible complete package. No installed private Studio source, settings, projects, credentials or personalized firmware may be read or copied.

**Tech stack:** Node 24, existing dependency-free public server/Studio overlay, existing public bootstrap and C++ SDK.

**Spec/evidence:** User's request to verify all updates are included before testing a project from scratch; docs/API.md, docs/LOCAL_STUDIO.md and docs/STUDIO_CONNECTION.md. Public ZIP SHA `d6707edbbcea2ed631dc7dcfb1d4ecabf487dae839ae4c3003f7529a03ce4f58`. Actual offline r2 update returns `upgrade_unknown_baseline` for this ZIP; none of its seven SDK profiles match. Current site r2 archives are internally consistent but explicitly not a full Studio release.

## Global constraints

- Retain fail-closed known-file/hash checks; adding unknown hashes alone is not a migration.
- Keep runtime data out of distribution; create fresh neutral projects from public templates.
- No provider/network requests on boot, save, ordinary reads or automated tests. Use injected transports for behavior checks.
- Do not use saved administrator/SSH/account credentials or alter the active board, current projects, owner pilot or running voice service.
- Build success, provider access and physical audio remain separate claims.
- Root alone integrates packages/Git; no publication claim until exact remote bytes are checked.

## Review focus

- A fresh public package must contain the account/module/resource tools rather than only describing them.
- Source/configuration/project changes must invalidate stale checks and firmware.
- Module installation must retain exact dependency pins and board lifecycle constraints.
- Factory layouts must get a validated complete USB plan with an explicit final write action.
- Reinitialization/update must preserve unknown edits and user data, and must not broaden permissions implicitly.

## Tasks

- [x] Verify immutable upstream ZIP, release, bootstrap and manifest; reproduce current program/SDK rejection using only public data.
- [x] Review and implement an explicit migration of the public program lineage, including platform/account integration and current design/build guards.
- [x] Review and align its neutral template/SDK with all five exact Xiaozhi dependencies and current instructions.
- [x] Integrate the public UI with account controls and validated full/app-only USB installation.
- [x] Build a reproducible complete distribution with a coherent manifest/release/bootstrap and corrected exact archive contracts.
- [x] Run failing-then-passing migration tests, full node tests, clean synthetic-project/native/HTTP/browser checks and install-only checks without private authorization.
- [x] Independently review the resulting public cohort; no Critical/Important findings remain after regression fixes.
- [x] Publish the exact verified full cohort to GitHub and verify the immutable remote bytes before providing the installation path.

## Verification evidence — 2026-11-17

- Complete candidate0.3.1/r3 contains2650 hash-checked public files. Archive SHA256 `5c6560f205a3536fd38e8f03801f3ccdbd934aa7d15aeb3bf93ab2acf60cc4bb`; the independent upstream bootstrap verifier accepts it.
- Final full test run:684 total,675 passed,0 failed,9 skipped (unprovided older reviewed fixtures). Fresh-public, source-witness, SDK before/after/r2-contract, variant and USB tests ran explicitly.
- Independent review found and regression-fixed two build races: stale completed turns and concurrent manual preparation. Only the owner can release its build lease. Source/config/thread/turn/project witnesses remain bound to the current preparation.
- Full packaging uses a copied explicit public source snapshot, dynamic imports from that snapshot, matching dry-run/apply changes and a final source witness. The guide-mutation regression fails without the witness and passes with it.
- Real install-only execution used official checksum-verified Node24.22.2 and Codex0.166.0 in an isolated runtime and new destination. Candidate delivery was injected from local files; no ChatGPT login was performed. This is not a clean-OS or live-GitHub installation claim.
- Browser checks exercised real server-rendered frames, new project creation, button input, saved basic/speaker selection and empty account connection form. No console errors. The unauthenticated chat state was reported honestly; first-login and real model replies remain user checks.
- A synthetic speaker/client reference was compiled by the actual existing remote compiler:1,831,424-byte application and all four verified artifacts. Final candidate hardware/template/module bytes equal the target-tested cohort. No provider request, device pairing or physical flash occurred.
- GitHub main now points to `5c82a27e8ca72658ace8d0cd3e7aff2494072ad3`. All11 published release files were downloaded from that immutable commit and matched the local SHA256 values. A second isolated install used the actual public GitHub transport and verified all2650 files with official cached runtimes. It did not sign in to ChatGPT or launch the editor; clean-OS, live model and physical checks remain separate.
- VPS publication is separate and was not performed. No saved SSH/admin credentials were used. Existing private Studio, projects, board and owner voice pilot were not accessed or modified. Temporary local QA service4392 was gracefully stopped.
