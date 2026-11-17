# Chat photo assets implementation plan

> **For agentic workers:** use superpowers:subagent-driven-development; assigned agents modify only their named files.

**Goal:** use a photo already sent in Studio chat as a renderable application resource without asking for a public URL or another upload.

**Architecture:** preserve the existing image input to ChatGPT. Expose bounded IDs for sent photos in the current project, resolve an authorized ID through the existing attachment store, convert its validated bytes locally, and append a verified RGB565/alpha resource to the existing artwork bank.

**Tech stack:** Node 24 built-ins, existing PNG rasterizer and managed-assets installer, macOS built-in `/usr/bin/sips` for the JPEG/WebP photos accepted by chat. No new package or network service.

## Constraints

- Read program sources and synthetic fixtures only; never use a personal project, settings or `auth.json` as implementation input.
- Resolve only IDs referenced by sent user messages in the active project; uploaded but unsent files are excluded.
- Preserve project/turn fences, current image-input order, append-only bank and protected SDK hashes.
- Return no private path, raw image, header or external public URL to the model.
- No compilation, provider request or flashing from this fix.
- Published r1 archives and the hardware/support r3/r4 cohorts remain immutable.

## Tasks

- [ ] Reproduce the URL-only/JPEG mismatch using synthetic images and current tool contracts.
- [ ] Test then implement the bounded local attachment-to-raster service.
- [ ] Test then wire sent-photo descriptors and current-turn image-order metadata into the server.
- [ ] Test then extend `kibi_import_asset` with the mutually exclusive attachment ID form.
- [ ] Package a new r2 updater and full Studio; retain all previous program preimages and neutral templates.
- [ ] Verify an actual local browser upload, model-tool import and render using synthetic data without a real model or provider.
- [ ] Apply only the named public program update to the installed Studio and leave its window running.
- [ ] Publish the coherent public release when the existing repository credentials permit it; report any concrete authentication blocker separately.

## Review focus

Wrong-project IDs, unsent uploads, stale turns, malformed images, conversion failures and duplicate imports must never modify another project or disclose a private path. A rendered photo does not prove target compilation or physical display output.
