# Kibi Server

Read docs/API.md and docs/superpowers/specs/2026-11-08-kibi-server-design.md. This is the public, standalone server module and website, separate from private Kibi Studio and the existing cloud infrastructure. Never read/copy their projects, credentials, protected app data or personalized firmware here.

Node 24, no runtime npm dependencies. web/ is shipped with the server; use exact API contract in docs/API.md. User-facing language is Russian. Palette #202D85/#FA9442/#FAF6EF and bundled Manrope with OFL. Live data comes from API; no fabricated devices or module readiness. Voice is implemented as an opt-in private TLS gateway: read docs/VOICE.md. Report its actual status; listening does not prove OpenAI access or physical audio. Schedules remain planned.

Keep administrator/device credentials private, require browser Origin and CSRF for mutations, hash device tokens, encrypt integration keys on disk. Only the official Telegram HTTPS host is allowed by the built-in sender. No automatic real Telegram messages in tests or on page load. External network tests must be explicit and use an injected transport when possible.

Do not commit .data, environment values, generated deployment credentials, private runtime files or logs. Docker must exclude these from its build context. Preserve data on update/reinitialization. Run node --test and documented local HTTP/browser checks before claiming a working deployment. A local test is not proof of installation on a user's VPS or physical board integration.

Root controls Git publication and integration. Assigned implementation agents change only their named files; no agent may create additional agents or touch the paused voice project.
