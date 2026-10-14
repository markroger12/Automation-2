# BUILD_STATUS — Blog Automation Studio 3.0

Evidence-based progress log. A milestone is only marked done when the listed commands actually passed in this repository. Live ChatGPT/WordPress flows are **not** claimed as verified unless stated.

## Owner decisions (override the original spec)

| Date | Decision | Effect |
| --- | --- | --- |
| 2026-10-14 | Use the **latest Node.js** | Built and tested on Node **26.11.1**; `engines.node >= 26`, setup refuses older Node. |
| 2026-10-14 | **No admin login / users / roles** (private, single-computer tool) | No User model, login, first-run admin or roles. Replaced by: bind to `127.0.0.1`, loopback Host check (anti DNS-rebinding), same-origin + double-submit CSRF on every mutation. `bcryptjs`/`jose` not used. Extension still pairs with a bearer key. |

## Milestones

| Milestone | Status |
| --- | --- |
| M1 Local foundation | ✅ done |
| M2 Queue and worker | ✅ done |
| M3 Websites and sessions | ✅ done |
| M4 ChatGPT extension vertical slice | ✅ done (fixture-verified; live ChatGPT not verified here) |
| M5 Single Article + content pipeline | ✅ done (scripted-ChatGPT verified; tasks stop at Needs Review until M6) |
| M6 WordPress drafts | ✅ done (real WordPress 6.5/6.7 verified; real Rank Math not available here) |
| M7 Links and general writer | ⏳ next |
| M8 Images and templates | ☐ |
| M9 Retire 2.0 + editorial tools | ☐ |
| M10 Bulk campaigns and workflow | ☐ |
| M11 Plagiarism evidence and hardening | ☐ |
| M12–M16 3.0 upgrades | ☐ |
| Throughput benchmark (≥6 verified drafts/hour) | ☐ not run — requires owner-authenticated ChatGPT + WordPress |

---

## M1 — Local foundation ✅

**Working**
- Next.js 15.5 App Router + React 19.2 + Tailwind 4.3 + TypeScript 5.9 (strict) on Node 26.11.1.
- Prisma 6.19 + SQLite at `data/app.db` (absolute path resolved at runtime; WAL; busy timeout). Initial migration `20261014000000_init` with core models (BrowserProfile, Website, Category, ArticleTask, ArticleStage, ArticleStageRevision, ChatGPTResponse, PromptTemplate/Version, QueueJob, WorkerStatus, Log, Setting, SEOReport, AuditLog, Workflow, WorkflowKeyword, SlotReservation, MediaAsset, DataMigration).
- `npm run setup`: idempotent (Node check, data dirs, `.env` only if missing, backup-then-migrate only when migrations are pending, seed missing settings + 14 default prompts, data-migration framework, browser detection, next steps).
- Prompt seeding rule implemented and tested: create once; upgrade only an untouched previous default; owner-customized prompts kept.
- Login-free request security: loopback-only Host, same-origin Origin/Referer, double-submit CSRF cookie + header; consistent JSON errors with field errors.
- Dashboard shell: responsive sidebar in the required order (Single Article separate from Bulk Campaigns), dark/light theme, health banner (worker/extension/sites), Overview with real counts, Settings (full Zod schema with groups and warnings), Logs (filters/pagination), Diagnostics (worker, lock, leases, queue, browsers, backups, errors, secret-stripped bundle download, backup button), Help/Setup.
- Unbuilt modules show an honest "Not built yet — planned for Mx" page and a `soon` badge (no fake data).
- Worker: single-owner lock (`wx` create, PID/host/heartbeat/TTL, PID liveness, stale/corrupt takeover, lost-ownership detection), DB heartbeat every 10 s, graceful SIGINT/SIGTERM shutdown that marks STOPPED and releases the lock.
- Backup/restore scripts (`VACUUM INTO`; restore moves the current DB aside).

**Commands run (all passed)**
```
npm install
npm run setup            # twice: second run created nothing, kept data, no backup needed
npx tsc --noEmit         # 0 errors
npx vitest run           # 4 files, 17 tests passed
npm run build            # compiled, 30 routes
npm run dev:all          # smoke: pages 200, worker online, diagnostics bundle 200
```
Smoke checks: Host `evil.example` → 403; PUT `/api/settings` without CSRF → 403; with CSRF → 200; invalid `taskConcurrency: 9` → 400 with field error; second `npm run worker` → refused ("Another worker already owns this data directory…"); Ctrl+C → "Worker stopped (SIGINT)", lock file removed.

**Limitations / user action**
- No Chrome in the build container, so `setup` warned "No Google Chrome or Microsoft Edge found" here; on Windows it detects Chrome/Edge in Program Files/LocalAppData.

---

## M2 — Queue and worker ✅

**Working**
- Database-backed queue (`src/lib/queue.ts`): idempotent enqueue (unique key), atomic compare-and-set claims, priority + `runAt`, leases with heartbeats, release (optionally without counting an attempt), bounded retry/fail, per-task cancellation, wake-up of sleeping article jobs.
- Stage engine (`src/worker/pipeline/engine.ts`): typed `PipelineStage`/`PipelineDefinition`; creates missing stage rows; skips completed/skipped stages; persists input snapshot, prompt, output, HTML/JSON, attempts, timings; outcomes completed / skipped / waiting (ChatGPT, no lease held) / paused (durable gates); configuration snapshot frozen at task start.
- Error mapping: Transient → bounded exponential backoff (stage-level attempts, `retryAttempts`); Fatal → FAILED without retry; LoginRequired / HumanCheck → LOGIN_REQUIRED/PAUSED with `pausedFor` + exact next action; UsageLimit → PAUSED until the window; UncertainSideEffect → NEEDS_REVIEW + critical Recovery incident; NeedsReview → NEEDS_REVIEW with reasons.
- `askChatGPT`: renders the owner's saved template (site override → saved → shipped default), refuses unresolved required placeholders (nothing sent), appends the explicit language line to text prompts, persists the exact prompt as a `ChatGPTResponse`, enqueues one ChatGPT job per stable operation ID, reuses a valid completed answer instead of resending, opens a new chat with a source-faithful context primer after a lost conversation (recorded as a conversation switch).
- ChatGPT job bridge (`src/lib/chatgpt/jobs.ts`) used by the extension API (M4): claim with conversation affinity + fair site rotation + shared account budget, progress heartbeats with sticky "sent" evidence, complete (normalized answer, fingerprint, wakes the article), fail codes LOGIN / HUMAN_CHECK / CONVERSATION_LOST / USAGE_LIMIT / CANCELLED / ERROR.
- Account-level rate control (`src/lib/chatgpt/rate.ts`): one shared backoff (4→30→60→120→240→300 s, Retry-After honoured), halves concurrency on 429, slow recovery, growth above the start value only after 30 healthy minutes with backlog.
- Dispatcher: article slots (3 in High-Throughput mode, adaptive 1–5; 1 in conservative mode), continuations always run, new tasks only when a slot is free, fair per-website ordering, paused sites and per-site quotas honoured.
- Recovery: startup audit (article/workflow jobs requeued from checkpoint; control jobs marked interrupted; expired ChatGPT leases requeued **with reconcile evidence** when the prompt may have been sent), 15 s lease sweeper, orphaned-task self-heal (never silently drop a job), Recovery incidents (deduplicated).
- Lifecycle actions: serialized `ensureArticleRun` (no duplicate runs on double submit), cancel (cooperative; outputs kept), retry (from first unfinished stage), resume.
- UI: Article Queue (live 3 s polling, status groups with counts, search/website/writer filters persisted per session, worker/tab ownership, next-run/backoff, bulk retry/cancel with confirmation), Article History (date filters, Rank Math shown only when verified, CSV export), Article detail (Overview, Titles, Research, Editor preview, SEO, Images, Stages, Prompt/Response history, Logs, Conversation), Recovery Center (open incidents with evidence and last screenshot, resume/retry/verify/dismiss, expired leases, slow tasks, backups). Article HTML is sanitized before display.
- Production metrics table with dedupe keys (stage timings recorded once per attempt) — feeds the M16 analytics.

**Commands run (all passed)**
```
bash scripts/dev-create-migration.sh queue_metrics_recovery   # + task_pause_media_response
npm run db:migrate        # 1 pending → backup created → applied
npx tsc --noEmit          # 0 errors
npx vitest run            # 7 files, 39 tests passed
npm run build             # compiled
npm run dev:all           # smoke (throwaway DB): worker claimed the task and, with no writer registered yet, set NEEDS_REVIEW "Writer module … not available"; /queue /history /recovery /articles/:id → 200
```
Tests prove: one claimer wins among 8 concurrent; no duplicate run on 6 concurrent submits (bug found and fixed: now serialized via a write-locking transaction); waiting on ChatGPT releases the lease without consuming attempts; re-running before the answer arrives never sends a second prompt; worker crash after "prompt sent" → reconcile info on reclaim, recovered answer saved once; lost conversation → new chat with primer; login/usage-limit pause instead of fail; unresolved placeholders block sending; retired-writer tasks go to review; dispatcher starts only 2 tasks with 2 slots and spreads them across sites (bug found and fixed: in-flight count now includes just-claimed tasks).

**Limitations**
- No writer pipeline is registered yet (M5/M7), so tasks created now go to Needs Review with an honest message.

---

## M3 — Websites and WordPress sessions ✅

**Working**
- Website CRUD with Zod validation and field errors: normalized public/admin URLs (`…/wp-admin/`), English/German, target country (presets + validated custom), IANA timezone, internal-link line (defaults "Also read:" / "Das könnte Ihnen gefallen:"), editor override, default category (must be a synced category of that site), Search Console property, per-site quota/priority/pause/active, per-site content/SEO/workflow overrides. Duplicate URLs refused. Removing a site is only allowed without articles (deactivate otherwise); profile folders are never deleted implicitly.
- One persistent Playwright profile per site in `data/profiles/<validated-slug>` (installed Chrome by default; Edge/Chromium via `.env`). Profile use is serialized per site; headless contexts are pooled and closed after 3 idle minutes; a visible window closes the pooled context first.
- Worker control actions (only the worker opens browsers), each followed live in the UI: **Log in** (visible window on the real login page; the owner signs in; "Remember Me" is pre-ticked so the session survives restarts; then editor detection + category sync), **Test session**, **Refresh session**, **Sync categories** (authenticated REST via admin-ajax `rest-nonce`, `/wp-json/` or `?rest_route=`, falling back to the categories admin table), **Detect editor** (Gutenberg vs Classic), **Open browser**, **Reset session** (confirmation), **Delete profile** (typed confirmation, audited).
- Bounded navigation (commit → DOM ready with timeout), host overlay handling that hides only known overlay elements (never `<html>`/`<body>`), viewport screenshots on errors, English and German admin detection.
- Publishing permission per site (`canPublish` off by default): enabling requires typing `ALLOW PUBLISHING`, separate opt-in for updating live posts, all changes audited.
- Session becoming ACTIVE automatically resumes tasks paused with `wordpress-login` for that site.

**Commands run (all passed)**
```
npx tsc --noEmit
npx vitest run                                              # 39 unit tests
npx vitest run --config vitest.integration.config.ts         # 4 integration tests (headless)
xvfb-run -a npx vitest run --config vitest.integration.config.ts   # same 4 tests with real headed windows
npm run build
npm run dev:all   # smoke: invalid site → 400 with field errors; unreachable site test → clear ERROR result; enabling publishing without the phrase → 400; deleting a profile without typed confirmation → 400; website detail page 200
```
Integration tests run against `tests/fixtures/fake-wordpress.ts` (a fake WordPress, not a real one): LOGIN_REQUIRED detection; manual login in the window (simulated owner typing in the test only — no password reaches app logs); session survives closing/reopening the browser; categories with real IDs via REST; REST disabled → admin-table fallback; Gutenberg and Classic detection; German admin; overlay hidden without hiding the document; expired login detected; reset/delete only on request.

**Found and fixed during M3**
- WordPress login cookies are session-only unless "Remember Me" is ticked, so a login would not survive a browser restart → the login window now pre-ticks it.
- Server pages passed functions to client components (500 on the site page) → result formatting moved client-side.

**Not verified here**
- No real WordPress site was reachable from the build container, so the live login/sync flow has only been exercised against the fixture. The selectors live in `src/wordpress/selectors.ts` and can be overridden in Settings → Advanced.

---

## M4 — ChatGPT Manifest V3 extension vertical slice ✅ (fixture-verified)

**Working**
- `extension/` (load unpacked): `manifest.json` (v3.0.0; permissions only storage, tabs, notifications, alarms; hosts only chatgpt.com + localhost/127.0.0.1), `background.js`, `content.js`, `adapter.js` (all ChatGPT selectors/heuristics in one file), `popup.html`/`popup.js`, icons.
- Pairing: Settings / Automation Chrome → create a `bas_…` key (shown once, only SHA-256 hash stored; rotate invalidates old key) → paste into the popup. The extension sends it as a Bearer credential only to the configured localhost origin.
- Agent endpoint `POST /api/extension/agent` (+ `/upload`, `/media/:id`): loopback Host only, chrome-extension Origin only, key check, 4 MB limit (12 MB images, magic-byte validated, re-encoded with sharp), Zod-validated actions hello / claim / progress / complete / fail (LOGIN | HUMAN_CHECK | CONVERSATION_LOST | USAGE_LIMIT | CANCELLED | ERROR) / release / report429, per-install rate limit, version-drift detection (no work handed out, no reload loops).
- Content-script algorithm: validates the conversation (ignores placeholder IDs), detects ready composer / login / challenge / usage limit / lost conversation / offline, recovers an already-submitted prompt (normalized SHA-256; evidence-based so regenerations are never "recovered" from an older identical prompt), types prompts as text paragraph by paragraph and verifies the full composer contents (no "Pasted text" files), attaches files only when asked, sends once, captures the real `/c/<id>` URL, waits for true completion (stop button gone + 3 stable reads + composer ready), clicks "Continue generating" (max 3), excludes tool/planning blocks, converts the final answer to Markdown (headings, tables, lists, emphasis, links) and never accepts an error/limit notice as an answer.
- Background: polls every 30 s idle / 1–3 s while busy, opens at most one tab per tick (1–5 tabs, only tabs it created), reuses a tab already showing the needed conversation, persistent outbox for results, checkpoints in `chrome.storage.session`, resume after content-script reload or service-worker restart, release on tab close, desktop notifications for login/human checks (never automated), badge states, pause-new-claims switch, reloads an idle tab whose page never loaded (bounded).
- Shared account budget server-side: backoff schedule + Retry-After + halved concurrency on 429/usage limits; time in backoff/human checks does not count toward generation timeouts.
- Automation Chrome page: five checked steps (Chrome installed, dedicated profile running — detected from the profile lock, extension loaded, paired, ChatGPT signed in), worker-run launcher with a dedicated `data/chatgpt-chrome` profile (only background-throttling flags; no security flags, no WebDriver/CDP), copyable extension path, live status, graceful "pause new claims" drain, and a **Send test prompt** button (one stored prompt → one saved answer).

**Commands run (all passed)**
```
npx tsc --noEmit
npx vitest run                                          # 9 files, 47 tests
npx vitest run --config vitest.integration.config.ts     # 18 tests (14 extension + 4 WordPress)
npm run build
npm run start:all + real extension in Chromium + fake ChatGPT → test prompt COMPLETED through the real Next.js route
```
Extension integration tests load the **actual unpacked extension** into Chromium against `tests/fixtures/fake-chatgpt` (a FAKE ChatGPT page routed onto https://chatgpt.com/ by Playwright — not live ChatGPT): handshake/claim/progress/complete, alternate DOM, late answer, multipart + Continue generating, tool/planning preamble, 20 000-character multi-line prompt, two simultaneous tabs, page reload mid-generation (recovered, sent once), stale conversation → CONVERSATION_LOST, login → paused (never automated), human check (waits, then pauses), usage limit → backoff + refused claims, tab closed while owning a job (released, reconciled, sent once), file attachment, missing DOM markers → error with debug snapshot.

**Found and fixed during M4**
- Concurrent progress reports could overwrite the sticky "prompt sent" evidence → per-job ordered handling in the extension + write-locked merge on the server.
- A usage-limit notice in the answer area was accepted as the answer → error/limit notices are now rejected explicitly.
- React-style re-renders detached the answer anchor → the anchor is re-resolved by turn index on every check.

**Not verified here (needs the owner)**
- Live ChatGPT: no signed-in ChatGPT session exists in the build container. The live "one stored prompt → one real response" check is the **Send test prompt** button on the Automation Chrome page; selectors may need tuning in `extension/adapter.js` if ChatGPT's DOM differs.

---

## M5 — Single Article, both writers, content pipeline ✅ (scripted-ChatGPT verified)

**Working**
- **Single Article** page (its own sidebar item): website, writer (only Celebrity Article Writer / Tigram Article Writer), keyword, secondary keywords as de-duplicated chips, category (required for Celebrity, optional for Tigram), country/language from the site with override, word-count target, FAQ count, title mode (auto / manual approval), article approval, per-task options. Draft autosaved to `localStorage` (opt-in "remember last choices"), Reset with confirmation, **Preview prompts** (renders the real templates with the real variables, unresolved placeholders shown), health alerts (worker, extension, site session). Submissions carry an idempotency key, so double-clicks create one task.
- Task creation snapshots every input (keyword, site, language, country, category, options, prompt versions) so later edits to settings/prompts do not change a running task. The retired Celebrity Writer 2.0 key is refused with a clear message.
- **Celebrity Article Writer** (Celebrity Writer 1.0 pipeline, 22 stages): precheck → duplicate precheck → titles (auto pick or manual approval gate) → research (identity/uncertainty analysis, evidence kept) → long article → final article → FAQs (exact count) → Quick Bio table (≥10 rows, confirmed full name) → assembly in the fixed order Intro → Quick Bio → body → FAQs → Conclusion → internal-link line → SEO check → quality gate → article approval → finalize.
- **Tigram Article Writer** (15 stages): one ARTICLE prompt returning SEO TITLE / META DESCRIPTION / URL SLUG + Markdown body, then CATEGORY chosen by ChatGPT **only from the synced category list** (skipped when the owner picked one or the site has a single category; unknown answers fall back to the site default or stop for review). No celebrity prompts and no Quick Bio.
- English (US) and German (DE) output: language line appended to every text prompt, German headings recognised, German slug transliteration (ä→ae, ß→ss).
- Model Markdown is cleaned (duplicate H1/title, preambles, repeated blocks) and converted to HTML; tables kept.
- **SEO checks**: transparent weighted checks (keyword in title/intro/H2/slug/meta, lengths, density, headings, FAQs, links, images) with score and per-check evidence; re-runnable.
- **Quality gate**: hard stops (missing body/sections, unresolved placeholders, wrong language, too short, model refusals, duplicate blocks…) block before WordPress; warnings end in Needs Review; owner override is audited.
- **Article detail**: approve title, research evidence, editor (visual / HTML / compare with the generated version, optimistic version check, discard edits), metadata (SEO title, meta, slug, focus keyword), SEO tab with re-run, regeneration with a preview of exactly which stages will be reset (dependency-aware via manifest `dependsOn`); previous outputs kept as revisions and old responses superseded, never deleted.
- **Prompt Manager**: list/edit per writer and stage, variable reference, validation (unknown/required variables), version history and restore, preview with sample data; seeding never overwrites customized prompts.

**Commands run (all passed)**
```
npx tsc --noEmit                                         # 0 errors
npx vitest run                                           # 12 files, 73 tests passed
npx vitest run --config vitest.integration.config.ts      # 18 integration tests
npm run build                                            # compiled
npm run dev:all   # smoke: Single Article page in a real browser — chips de-duplicate, values survive refresh, preview shows the example title, Generate opens the task; invalid input → 400 with field errors; retired writer → 400; worker ran PRECHECK/DUPLICATE_PRECHECK and queued the TITLES prompt for the extension
```
`tests/unit/single-article-e2e.test.ts` drives the real worker engine with **scripted ChatGPT answers** (`tests/helpers/fake-answers.ts` — canned text, not real model output): exact inputs preserved from form to prompt to detail; English celebrity article assembled in the required order; German site (German prompts, headings, slug) surviving a worker crash midway without duplicate prompts; manual title approval pause/resume; regeneration resets only dependents and keeps revisions; Tigram general topic runs only ARTICLE/CATEGORY; Tigram skips CATEGORY when the owner chose one; same-site duplicate keyword pauses until allowed.

**Found and fixed during M5**
- Cheerio fragment mode dropped the `<body>` wrapper, so assembly/SEO/quality saw an empty article → switched to document mode in all three.
- Test fixtures produced repeated sentences that the duplicate-block check (correctly) flagged → fixtures now use unique sentences.

**Limitations**
- The WordPress draft, Rank Math, external/internal links, images and humanizer stages are present in the pipelines but **skipped with an explicit reason** ("arrives in M6/M7/M8/M9"). Because no verified WordPress draft exists yet, finished tasks end in **Needs Review**, never Completed.
- Live ChatGPT output has not been run through these parsers in this container; the parsers are tolerant (bold labels, quotes, German labels) but may need tuning against real answers.

---

## M6 — WordPress drafts, publish guard, Rank Math ✅ (real WordPress verified; Rank Math fixture-only)

**Working**
- **Drafts through the logged-in admin session** (`src/wordpress/client.ts`): cookies of the site's persistent profile + the REST nonce WordPress gives logged-in users — no passwords, no Application Passwords. Works with pretty permalinks (`/wp-json/`) and plain permalinks (`?rest_route=`). A missing/expired login pauses the task (`LOGIN_REQUIRED`, resumes automatically after “Log in”).
- **Create/reopen without duplicates** (`src/wordpress/drafts.ts`): a stored post ID is always reopened; a create attempt is recorded *before* sending and the post ID is saved the moment WordPress returns it; a lost acknowledgement is reconciled on retry (same title/slug/time → adopted); ambiguous evidence pauses for review with the candidate posts (Recovery Center → article → “Use #N” / “Create a new draft”). Trashed/deleted drafts, live/scheduled posts and edits made in WordPress are never overwritten silently (owner chooses “Overwrite WordPress draft”).
- **Verified saves**: every save is read back — status `draft`, title, content (same words/headings/links), exactly one category (Uncategorized/Allgemein removed), slug (WordPress `-2` suffix reported as a possible duplicate), tags (looked up, created when allowed). Featured image upload with alt text, reused on later saves.
- **Editor-correct content**: Gutenberg gets core blocks (paragraph, heading, list/list-item, table incl. Quick Bio, custom HTML fallback) — validated as *valid blocks* in the real WordPress 6.5.5 and 6.7 editors; Classic sites get plain HTML. The editor check detects the real editor, re-saves in the right format and falls back to plain HTML if any block is invalid.
- **Publish guard** (`src/wordpress/publish-guard.ts`): one classifier used at the service boundary (every app request) and the network boundary (every request of every WordPress browser context): REST `publish/future/private/pending` in body/query/method-override/batch, Classic Publish/Schedule button, pending/private saves, Quick Edit, bulk edit, XML-RPC and deletions → HTTP 403 before reaching WordPress, logged + audited. Permits only via `withPublishPermit` (fresh `canPublish` + typed acknowledgement, one post, short-lived) for the M10 scheduler; the owner's own “Open browser” window may publish by hand only on sites that allow publishing. A static test fails if any other module sends WordPress requests or asks for a publishing status.
- **Rank Math** (`src/wordpress/rank-math.ts`, `editor.ts`): focus keyword / SEO title / description written via Rank Math's own REST endpoint, then read back from the editor (store or form fields; a score shown beside the keyword is not mistaken for keyword text); the score is only ever *read* from the panel (stable over 3 reads) — never computed. Below target (default 75): up to 3 rounds — local metadata fixes first (title starts with keyword, meta from an intro sentence with the keyword, slug), then the editable `SEO_CORRECTION` prompt, whose rewrite is rejected if it adds >15 % / removes >30 % words, loses a heading/link/image, changes language, exceeds the density cap or fails the quality gate. Owner edits are never rewritten. Unfixable items become specific review reasons. Per-site mode: Required / Use when installed / Off.
- **VERIFIED_COMPLETE**: final read-back; an article counts as COMPLETED (and in the ARTICLE_VERIFIED metric) only with a verified draft and no open review reasons.
- **UI**: article **WordPress** tab (post link, status, slug, editor, verification times, guard notice, Rank Math fields/score/recommendations, correction rounds with before/after text, Save again / Overwrite / Create new / Use #N with confirmations); Websites page shows REST reachability, Rank Math detection and blocked publish attempts; Recovery Center links uncertain creates to the choice UI; Settings: Rank Math mode, content corrections, create missing tags.

**Commands run (all passed)**
```
bash scripts/dev-create-migration.sh wordpress_drafts      # wpContentHash, wpSlug, wpVerifiedAt, rankMathReport
npx tsc --noEmit                                            # 0 errors
npx vitest run                                              # 13 files, 86 tests
npx vitest run --config vitest.integration.config.ts         # 4 files, 26 tests (14 extension, 4 sessions, 7 drafts, 1 toolchain)
WP_E2E_ADMIN_URL=… npm run test:e2e:wordpress                # 7/7 on WordPress 6.7-alpha-58716, 7/7 on WordPress 6.5.5
npm run build                                               # compiled
npm run dev:all   # full-stack smoke, throwaway data dir: real Next.js + real worker (tsx) + real WordPress 6.7; site added via API,
                  # owner login simulated in the profile, Test session (REST reachable, Rank Math not detected), Sync categories via REST,
                  # Single Article task answered by a scripted client through the real /api/extension/agent → draft #6 created and verified,
                  # honest NEEDS_REVIEW “Rank Math is not active”; WordPress tab rendered in Chromium with no console errors
```
**Real WordPress used here:** disposable WordPress 6.7-alpha-58716 and 6.5.5 from the npm package `@wp-playground/wordpress-builds@0.9.19`, served by PHP 8.3's built-in server with the SQLite Database Integration plugin (wordpress.org itself is not reachable from this container). Real Gutenberg and Classic editors (Classic switched on via a test-only mu-plugin). The e2e suite proves: one draft with category/tags/slug/valid blocks; reopen without duplicates; lost acknowledgement adopted; WordPress edits not overwritten until the owner chooses; publish blocked via REST (publish/future/delete), the Gutenberg Publish button, in-page fetch for every publishing state, Quick Edit and the Classic Publish button; featured image upload; Classic detection and plain-HTML re-save.

WordPress step latency measured in the smoke (local WordPress, no Rank Math): draft 0.6 s, editor check 2.8 s, final verification 0.3 s.

**Found and fixed during M6**
- Keyword density multiplied by the keyword's word count, so natural multi-word keywords (e.g. “Tom Kaulitz Heidi Klum”) were flagged as stuffing and the spec's advisory 15–18 mentions would always fail → density is now mentions per 100 words (Rank Math's convention).
- The worker (tsx) wraps named functions in `__name()`, which does not exist inside browser pages → “Sync categories” failed on a real site (pre-existing M3 bug; Vitest compiles differently so tests missed it). Every WordPress context now defines a no-op `__name`; `tests/integration/worker-toolchain.test.ts` runs the check under tsx with a negative control.
- Category sync on plain-permalink sites hit an HTML redirect from `/wp-json/` → now uses the verified REST client (admin-table fallback kept).
- Later session checks erased the REST/Rank Math capability result shown on the website page → merged.
- `BAS_DATA_DIR` moved profiles/media but not the database → it now moves the database too unless `DATABASE_URL` is customized; tests also load a setup file that isolates every test process from `data/app.db`.
- Switching a draft between block and Classic format was not detected as a change → format now counts.
- `?rest_route=` URLs with a stray `?` were not parsed as routes by the guard → fixed (WordPress had answered 404, so nothing was bypassed).
- Expected duplicate-key inserts (metrics/incidents) printed Prisma errors → look-up first.
- Relative times caused React hydration warnings; a missing favicon caused 404 console errors → fixed.

**Not verified here (needs the owner)**
- **Real Rank Math**: the plugin cannot be downloaded in this container. Rank Math behaviour is tested only against the fake WordPress fixture, whose panel uses its own documented rules (not Rank Math's algorithm). The endpoint (`rankmath/v1/updateMeta`), score and recommendation selectors are best-effort and overridable in Settings → Advanced (`rankMathScore`, `rankMathRecommendations`, `rankMathTabTrigger`). If the score cannot be read, the article says “not verified” — it is never estimated.
- German WordPress admin: covered by the fixture only (no German language pack offline). The code relies on IDs and returned post status, not button texts.
- Live sites behind security plugins/hosting overlays beyond the Hostinger-style fixture.
- **Throughput checkpoint after M6** (5 live article-to-draft flows, then the 2-hour benchmark): not run — it requires the owner's signed-in ChatGPT and real WordPress sites. No throughput claim is made.
