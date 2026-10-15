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
| M7 Links and general writer | ✅ done (local fake-web + real WordPress index verified; live third-party sites not checked here) |
| M8 Images and templates | ✅ done (fake ChatGPT/Commons + real WordPress 6.5/6.7 verified; live ChatGPT images and live Commons not verified here) |
| M9 Retire 2.0 + editorial tools | ✅ done (scripted-ChatGPT + full-stack agent-protocol smoke; live ChatGPT not verified here) |
| M10 Bulk campaigns and workflow | ✅ done (fake + real WordPress 6.5/6.7 scheduling verified; Search Console requests are manual, not automated) |
| M11 Plagiarism evidence and hardening | ✅ done (plagiarism checker on a local fake web; hardening, diagnostics, a11y 0 violations; live checks in RELEASE_CHECKLIST §4 need the owner's PC) |
| M12 Duplicate detector, quality report, router rules | ✅ done |
| M13 Research evidence ledger, internal-link decisions | ✅ done (local fake web; live sources not checked here) |
| M14 Image Studio and WordPress manager hardening | ✅ done (fake + real WordPress 6.5/6.7 verified; the owner's Chrome and live sites not verified here) |
| M15 Search Performance and Content Refresh | ✅ done (fixture exports + fake and real WordPress 6.5/6.7 verified; live Search Console data and live sites not verified here) |
| M16 Analytics, Website Control, recovery, benchmark report | ✅ done (seeded data + real WordPress 6.5/6.7 e2e; the live 2-hour benchmark is NOT RUN) |
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

---

## M7 — Verified external and internal links ✅

**Working**
- **External links** (`EXTERNAL_LINKS`): the editable shared prompt asks ChatGPT for `LINK: phrase | URL` rows; every candidate is then checked locally before anything is inserted:
  - policy: no social media, shops, URL shorteners, net-worth aggregators, gossip sites, downloads, credentials in URLs; Wikipedia only in the article's language; official/.gov/.edu and reference sites ranked above news, IMDb and Wikipedia;
  - **SSRF-safe fetch** (`src/lib/links/net.ts`): http/https only, default ports, every hop resolved and refused if private/loopback/link-local/CGNAT/multicast/reserved (IPv4 + IPv6 incl. mapped), connection pinned to the checked address, redirects to another site refused *before* contacting it, max 5 redirects, 10 s / 1.5 MB caps, no cookies; HTTPS tried first;
  - content: HTML only, not a soft 404, not a disambiguation page (EN/DE), title/heading identifies the phrase;
  - placement: exact phrase in body text only (never headings, never inside links, never the focus keyword), at most two links per paragraph (a later mention is used when a paragraph is full), each phrase/URL once, at most *maxExternalLinks* (default 5), Wikipedia at most half of the added links.
  - Every accepted/rejected candidate is logged with its actual reason. No passing link → the article is kept, with an informational note.
- **Internal links** (`INTERNAL_LINKS`):
  - per-website **link index** (`LinkTarget`): published posts only, read from the site's public REST API (no browser), falling back to the logged-in session; incremental by modification date, full pass daily marks unpublished/deleted posts REMOVED; app-created posts carry their primary keyword; broken targets are marked and skipped; changed URLs are followed and updated;
  - selection: topic relevance over recency (keyword/topic words in title/slug/keyword, excerpt, same category; EN/DE stopwords, umlauts), then the previous app article, then the latest real post; never the article itself, never drafts; the chosen URL is verified before the draft is saved;
  - one “Also read:” / “Das könnte Ihnen gefallen:” line at the very end, plus up to *maxContextualInternalLinks* contextual links where a related post's own phrase already appears in the body (placed at assembly, after any humanizer edits);
  - first article on a site: no line, an informational note (not a review reason).
- **UI**: article **Links** tab (added/rejected external links with reasons, the internal line with why, contextual links, candidate preview, “Use this” / “Remove line” / “Automatic” — the owner's choice is kept on later runs, so no duplicate line appears, and the same WordPress draft is updated); Websites page shows the link index (published/broken/removed, last refresh) and a **Refresh link index** action; Settings: index refresh interval, link-check timeout.

**Commands run (all passed)**
```
bash scripts/dev-create-migration.sh link_index
npx tsc --noEmit                                         # 0 errors
npx vitest run                                           # 14 files, 94 tests
npx vitest run --config vitest.integration.config.ts      # 5 files, 31 tests (incl. 5 link tests over real HTTP)
WP_E2E_ADMIN_URL=… npm run test:e2e:wordpress             # 7/7 on WordPress 6.7-alpha, 7/7 on 6.5.5 (now also checks the link index)
npm run build                                            # compiled
npm run dev:all   # smoke (throwaway data dir, real WordPress 6.7): link index read via the public REST API, “Also read: Hello world!” verified and
                  # placed in draft #6; Links tab rendered in Chromium without console errors
```
Link verification tests run over real HTTP against a local **fake web** (named hosts such as en.wikipedia.org resolved to 127.0.0.1 by a test-only lookup — fixtures, not the real sites): matching page accepted (HTTPS preferred, HTTP noted), disambiguation / wrong subject / soft 404 / PDF rejected, off-site redirect refused before contact, redirect to an untrusted loopback host and a private 10.x address refused, non-default ports refused, size and time caps, no cookies sent. Stage tests: focus-keyword anchor, missing phrase, social media, redirect tracker rejected; Wikipedia ≤ half; most related published post chosen over a newer unrelated one; drafts never linked; German site's first article without a line, then a newly published post found and its changed URL followed; self-link avoided; unpublished post removed from the index.

**Found and fixed during M7**
- Cheerio's `before()` does not work on text nodes, which garbled inserted links → text nodes are replaced with escaped text + link.
- Link stage notes (“no external link passed”, “first article, no internal line”) are informational, not review reasons — otherwise every first article and every link-less article would wait for review.

**Not verified here**
- Live third-party sites (Wikipedia, IMDb, official pages): this container reaches the internet only through a proxy that the link checker does not use, so live link verification runs on the owner's machine. ChatGPT's real link suggestions have not been run through the checker here.

## M8 — Images and branded templates ✅

**Working**
- **IMAGES stage** (both writers, optional per site/article; failures never block the text):
  - **General (Tigram)**: an editable IMAGE_PLAN prompt in the article conversation (featured + two body images with alt text), then one IMAGE_GENERATION ask per slot in new chats (asked together, then awaited). The extension (v3.1.0) captures the generated image from the page (same-origin, or from ChatGPT's two image CDNs through the background worker) and uploads it to `/api/extension/upload` (12 MB cap, magic bytes checked).
  - **Celebrity**: owner uploads first, then a bounded **Wikimedia Commons** gallery (no API key): logos/signatures/maps/posters, small and oddly shaped files, and files not naming the person are skipped; downloads use the SSRF-safe fetcher (12 MB cap, private hosts blocked); images are normalised through sharp buffers (metadata stripped); exact duplicates are removed by SHA-256 and near-duplicate crops by perceptual hash (dHash). An optional ChatGPT photo check marks watermarks and collages and suggests alt text (it never identifies anyone). A re-run reuses photos already downloaded for the article; photos the owner marked “Don't use” never come back.
  - **Owner uploads** (Images tab) fill the slots before anything searched or generated, in upload order (featured, body 1, body 2); for general articles nothing is generated for an uploaded slot.
  - **Rendering**: one production renderer (`src/images/render.ts`, sharp) composes the site template on a true 1920×1080 canvas: photo slots with smart crop (attention) or a focus point, fixed photos, logo with optional plate, text with `{{title}}`/`{{site}}`/`{{keyword}}` (auto-fit down to 60 %, then an ellipsis), rectangles/circles with borders, sanitized SVG, rotation, opacity and clipping. Output is 1200×675 or 1920×1080 WebP within the byte budget (quality steps, then smaller size). File names come from the slug (`slug.webp`, `slug-1.webp`, `slug-2.webp`). Never the same photo twice across slots; a two-photo design with one photo falls back to the single-photo preset.
  - **Placement**: body image 1 before the second article H2 (after the Quick Bio in celebrity articles, never before the FAQs or conclusion), body image 2 one paragraph before the FAQ section. Featured image and body images are uploaded to the WordPress Media Library **once** with alt text (IDs persisted, re-used on re-saves, re-uploaded only if deleted in WordPress); body images become core image blocks (`wp-image-N`), the featured image is set as featured media.
  - Missing images: a note and a text-only draft, or NEEDS_REVIEW when the site requires images.
- **Image Template Designer** (`/image-templates`, per website): true 1920×1080 canvas with separate featured/body templates (body defaults to a clean photo crop), drag/resize (8 handles, Shift keeps the ratio)/rotate (Shift: 15° steps), layer list (order, hide, lock), undo/redo (Ctrl+Z / Ctrl+Shift+Z, typing coalesced into one step), snapping to canvas and layer edges/centres (Alt bypasses), arrow-key nudge (Shift: 10 px), duplicate/delete, zoom/fit/100 %, presets (single photo · corner logo, split photo · centre divider and logo, body photo · corner logo), accent and background colour, logo upload (PNG/JPEG/WebP/GIF; SVG sanitized and rasterized), fixed-photo library, JSON export and import (own format or Polotno-like: pages scaled proportionally, transforms kept, image URLs never fetched, SVG sanitized, nothing executed). The **live preview is rendered by the production renderer** (debounced); **Check final size** encodes with the site's real output size and byte budget. Saves are validated server-side (schema, unique layer IDs, SVG sanitized, asset references must belong to the site) and audited. Unsaved changes are flagged and guarded.
- **Article Images tab**: rendered slots (size, bytes, WordPress media ID, alt text), notes, owner uploads (multipart, CSRF-checked, max 8 × 12 MB), collected photos with source URL (provenance only), “Don't use”, **Regenerate images** (re-assembles and updates the same WordPress draft), link to the template.
- No image-rights/licensing checks or approval gate (owner decision).

**Commands run (all passed)**
```
npx tsc --noEmit                                          # 0 errors
npx vitest run                                            # 15 files, 108 tests (new: renderer pixels, sanitizer, Polotno import, editor math/history, placement)
npx vitest run --config vitest.integration.config.ts       # 6 files, 38 tests (new: 6 image tests incl. designer API, uploads, re-runs; extension image capture)
WP_E2E_ADMIN_URL=… npm run test:e2e:wordpress              # 7/7 on WordPress 6.7-alpha-58716, 7/7 on WordPress 6.5.5 (each from a fresh disposable database)
npm run build                                             # compiled
npm run start     # UI smoke, throwaway data dir, real Chromium: designer — logo upload, drag 80→150, undo/redo/nudge, live preview,
                  # final size 1200×675 WebP 20 KB of 342 KB, save + reload, body template, Polotno import; Images tab — 2 uploads,
                  # “Don't use”, Regenerate disabled while queued; no console errors
```
Image integration tests use the real engine with scripted ChatGPT answers, a **fake Wikimedia Commons** (local HTTP server; `commons.wikimedia.org`/`upload.wikimedia.org` resolved to 127.0.0.1 by a test-only lookup) and the fake WordPress: three generated images rendered, placed and uploaded once (no duplicate media on re-save); Commons gallery with logo/small/duplicate/near-duplicate crop skipped and distinct photos per slot; text-only fallback and NEEDS_REVIEW when images are required; validated template save (unknown asset refused, SVG scripts removed), SVG logo rasterized, CSRF enforced on uploads, preview and final render; pipeline uses the saved template's fixed photo and logo; owner upload used first after regeneration, Commons photos reused (nothing downloaded twice), removed photo never used again; general article with three uploads generates nothing.

**Found and fixed during M8**
- A regenerated celebrity article lost its whole Commons gallery: the photos downloaded on the first run were treated as “exact duplicates” of themselves → photos already stored for the article are reused; only repeats within one run are duplicates.
- Body image 1 in celebrity articles was placed one section too late (before the third H2) → now before the second article H2 as the spec says (the Quick Bio is the first).
- Designer canvas stuck at 10 % zoom after switching to a body template (the size observer stayed on the unmounted canvas) → callback ref re-attaches.
- The test fixture photos shared one composition, so the perceptual hash rightly called them near-duplicates → structurally distinct fixtures.
- The extension permission test predated image capture → it now lists the two ChatGPT image CDN hosts explicitly (still no wildcard hosts).
- The very first 6.5.5 e2e attempt after restarting the disposable servers failed in its setup step (error not captured); the rerun from a fresh database passed 7/7, and so did 6.7.

**Not verified here**
- Live ChatGPT image generation and capture: verified only against the fake ChatGPT page; the generated-image selector may need adjusting on the live site (it lives in `extension/adapter.js`). Reload the extension (3.1.0) in Automation Chrome.
- Live Wikimedia Commons (this container reaches the internet only through a proxy that the fetcher does not use).
- Optional **face detection** is not implemented (no local model); framing uses sharp's attention-based smart crop and optional focus points. Optional **quality enhancement** has a setting but no local tool; when enabled the stage notes that originals were used.

## M9 — Retire Celebrity Writer 2.0, editorial humanizer, editorial tools ✅

**Working**
- **Celebrity Writer 2.0 retirement** (versioned, idempotent data migration `2026-10-14-retire-celebrity-writer-2`, run by `npm run setup`):
  - writes a backup of every value it will change to `data/backups/migrations/` first; `npm run db:rollback-retirement -- <file>` restores them;
  - 2.0 tasks become read-only legacy records (outputs, post IDs, conversations, prompts and logs all kept);
  - unfinished 2.0 tasks go to NEEDS_REVIEW with “Retired writer — choose a supported writer to create a new task”; their waiting jobs are cancelled, not deleted;
  - stored writer preferences pointing at 2.0 (global settings, website overrides, writer lists) move to the Celebrity Article Writer;
  - custom 2.0 prompts are kept as a read-only archive in Prompt Manager, and saving or restoring them is refused;
  - exactly two writers are offered or accepted: UI, API (a stale tab gets HTTP 400), engine (an injected 2.0 job goes to review and sends no prompt) and actions;
  - a 2.0 record created after the migration is still treated as read-only (derived from the writer key, not only the flag).
- **HUMANIZE stage** (both writers, after images, before assembly; on by default):
  - Body paragraphs get labels [P1]… and are batched (~1,200 words). Links, bold and italic become lossless marks; paragraphs with other markup, fewer than 12 words, or the internal-link line are never sent.
  - The local editor's flags and article-wide observations go with each batch: empty phrases (each occurrence counted), banned openers, inflated words, dashes, repeated openers, uniform sentence length.
  - **Fact locks** keep the original paragraph with the specific reason when a rewrite changes any of:
    - numbers (digits and number words) or month names;
    - quotations, link anchors or links, bold/italic text, or the required names;
    - the keyword count per paragraph, or the language.
    The same applies when a rewrite adds a name or entity (English), weakens hedging (“reportedly”, “soll”…), adds certainty, returns more than one paragraph or HTML, or goes beyond ±20 % length (configurable). It is also kept when fewer than 45 % of the content words survive.
  - German tolerance is documented in `src/lib/humanizer/validate.ts`: inflected names are accepted (Klums, Kaulitz’), and number words are compared by stem.
  - Regeneration always starts from the saved unedited body, never from the humanized output. Each batch is its own prompt, so a retried batch never re-sends or overwrites an accepted one. On the last retry a still-failing batch keeps its original paragraphs instead of failing the article.
  - Settings: on/off (also per website), all or flagged-only paragraphs, batch size, length tolerance.
  - Diagnostics: counts edited / kept / unchanged / not sent, before → after. They are editorial measures, not an AI-detection score.
- **Humanizer page** (`/humanizer`):
  - Input: a saved article (its edited version if any) or pasted text/HTML.
  - Options: all or flagged-only paragraphs, and an optional prompt edit for this run only (validated; must keep `{{paragraphs}}`).
  - Runs are queued on the worker's humanizer queue. Prompts go through the same extension bridge as article prompts, owned by the run instead of a task, and the worker is woken when an answer arrives.
  - Output: original and rewritten paragraphs side by side, with status, flags and rejection reasons; diagnostics; copy HTML/text; export .html/.txt; cancel; history.
  - **Apply to article** saves an owner edit, with the previous version kept in history. It never touches the WordPress draft, and it is refused if the article changed after the run started.
- **Editorial Tools hub** (`/editorial`): available and upcoming tools, recent humanizer runs and editorial history. The article view gets a **Humanizer** tab (stage results side by side plus this article's runs).

**Commands run**
```
bash scripts/dev-create-migration.sh humanizer_runs        # ChatGPTResponse.taskId optional + runId; HumanizerRun (existing rows copied, nothing dropped)
npx tsc --noEmit                                           # 0 errors
npx vitest run                                             # 19 files, 148 tests (new: humanizer marks/fact locks/planning 25, stage + page runs 7, retirement 6, site overrides 2)
npx vitest run --config vitest.integration.config.ts <file>  # 6 files, 38 tests, all passed (run file by file — see below)
WP_E2E_ADMIN_URL=… npm run test:e2e:wordpress               # 7/7 on WordPress 6.7-alpha-58716, 7/7 on WordPress 6.5.5 (fresh disposable databases)
npm run build                                              # compiled
npm run setup (fresh data dir)                             # both data migrations applied, nothing to change, no backup written
npm run setup (M8 smoke data dir)                          # humanizer_runs schema migration applied with automatic pre-migrate backup; data migrations applied
npm run start:all # full-stack smoke, throwaway data dir: real Next.js + real worker; a scripted client speaking the real
                  # extension agent protocol (hello/claim/progress/complete) answered the HUMANIZE prompt; the run finished
                  # with P1 edited, P2 kept (“Numbers changed (before: 2019; after: 2020)”), P3 not sent; Humanizer and
                  # Editorial pages rendered in Chromium without console errors
```

**Found and fixed during M9**
- **Website overrides hid the global settings.** Zod 4 applies a field's default even inside `.partial()`, so every website's overrides parsed (and, when saved from the website form, were stored) as the full set of shipped defaults. Global changes to words, FAQ count, review threshold, Rank Math mode, links, images, approvals and the humanizer switch had no effect on any site.
  - The override schema now has no defaults: unset means “use the global setting”.
  - Data migration `2026-10-14-unpin-default-site-overrides` (backup first) clears only override groups holding exactly the full default set. Any group with an owner value is kept.
- A single invalid stored setting (e.g. a leftover 2.0 writer preference) made `getSettings` fall back to all defaults, silently ignoring every owner setting. Now only the invalid key falls back.
- German filler phrases were missed after an opener (“Zudem *ist es* erwähnenswert”), so both word orders are listed. Filler counts now count every occurrence.
- A pasted text without any editable paragraph used to be queued anyway. It is now refused up front with the reason (too short, or nothing flagged in flagged-only mode).
- Humanizer runs showed the article label “Verified complete”; they now have their own statuses.
- The first full integration run stalled in `extension.test.ts`: the test harness could not read `chrome.storage` in the extension's service worker while the machine was also building and serving the smoke app, and the run was stopped by hand. Re-run on its own: 15/15. The other five files passed one by one (images 6, links 5, drafts 7, session 4, toolchain 1).

**Not verified here**
- Live ChatGPT answering the humanizer prompt (scripted answers and a scripted agent-protocol client only). How often real rewrites pass the fact locks is unmeasured; the thresholds (45 % content-word overlap, ±20 % length) may need tuning on real output.
- Name and entity checks are heuristics (capitalized-word runs; new-entity detection in English only), so they can miss a renamed entity or reject a legitimate rewrite.

## M10a — Bulk Campaigns and Smart Router ✅

**Working**
- **Import** (`src/lib/campaigns/parse.ts`):
  - formats: one keyword per line, `keyword | secondary1, secondary2 | example title`, CSV with headers (keyword, secondary_keywords, title, website, category, kind/writer, language, priority, notes; quotes and embedded commas/newlines) and tab-separated columns pasted from a spreadsheet, with or without a header;
  - at most 1,000 rows;
  - each row keeps its original text; invalid rows are flagged, never dropped.
- **Smart Router** (`src/lib/campaigns/router.ts`, version `rules-2026.10-1`):
  - deterministic EN/DE rules (person intents, topic intents, product/brand/place/work words, name evidence) route only to the Celebrity Article Writer or the Tigram Article Writer;
  - low confidence or mixed intent gives UNKNOWN, which asks the owner, as do names that overlap things (“Tokio Hotel”);
  - each decision stores version, confidence and rationale; a row's writer column or the owner's choice wins, and the campaign can force one writer;
  - 2.0 is never a writer.
- **Preview** (no writes):
  - row checks: website and category per row, exact and near duplicates (word order, plurals, small typos; different numbers stay different) within the website, existing tasks on the website, and already-published posts from the link index;
  - per-row status: ready / choose writer / choose category / duplicate? / invalid / excluded;
  - corrections by line (writer, category, keep as a separate article, exclude) never change the input text.
- **Campaigns**:
  - Creating a campaign stores the input text as entered plus one row per record, then the worker queues one standard task per READY row with a per-row idempotency key, so re-submits, duplicate jobs and restarts never duplicate tasks.
  - Queueing runs on the restart-safe workflow queue. A worker killed mid-way is requeued at startup and continues; a row whose task was created just before the crash is reconciled to it.
  - Controls: pause (no new article of the campaign starts; checked by the dispatcher), resume, cancel (unstarted rows cancelled, running articles stop at a safe point, nothing deleted).
  - Per-row actions: retry, reprioritize (task and queued job), correct writer or category, or keep as a separate article for rows not yet queued. A queued row keeps its approved writer.
  - CSV export of rows with task status, post ID/edit URL, SEO and Rank Math scores and review reasons; reusable templates.
  - Campaigns never publish.
- **UI**: `/campaigns` (list with progress), `/campaigns/new` (paste or load a file, options, templates, preview with filters, pagination and bulk corrections), `/campaigns/[id]` (progress, controls, rows with article links, bulk actions, export).

**Commands run (all passed)**
```
bash scripts/dev-create-migration.sh bulk_campaigns        # Campaign, CampaignRow (new tables only)
npx tsc --noEmit                                           # 0 errors
npx vitest run                                             # 21 files, 160 tests (new: parser 5, router 2 incl. a curated 36-keyword EN/DE
                                                           # dataset with a confusion matrix and no confident misroutes, service 5)
npm run build                                              # compiled
npm run start:all # UI smoke, throwaway data dir, Chromium: 6 pasted rows → 3 ready, 1 needs a writer, 1 duplicate, 1 invalid;
                  # writer chosen + duplicate kept → 5 ready; created; the real worker queued 5 tasks; pause/resume; CSV export
                  # (header + 6 rows); list page; no console errors
```
Service tests: 1,000-row fixture → exactly 1,000 tasks and 1,000 article jobs in about 23 s locally, nothing created on a re-run; restart after 50 of 120 rows plus a crashed half-finished row → 120 tasks, one per row; preview leaves the database untouched; the dispatcher starts a lower-priority task while a higher-priority task of a paused campaign stays queued.

**Found and fixed during M10a**
- The existing-task lookup for a 1,000-row preview exceeded SQLite's bound-variable limit, so it now runs in chunks.

## M10b — Workflow scheduler, approved publishing path, Publishing Calendar ✅

**Working**
- **Workflow per website** (`/workflow`, `src/lib/workflow/service.ts`):
  - settings: on/off, writer (Auto = Smart Router, or one of the two writers), daily `h:mm AM/PM` slots in Asia/Karachi, active weekdays (none = every day), write-ahead hours (0 = start as soon as queued), backlog cap (default 10), images (inherit/on/off), retry cap, “remind me to request indexing” and the Search Console property;
  - switching on without a slot, an invalid slot or an unknown time zone is refused; slots are normalized and sorted;
  - keyword import uses the campaign parser (lines, `keyword | secondary | title`, CSV, pasted spreadsheet columns) with a preview; duplicates within the workflow are left out unless kept on purpose;
  - queue actions: choose writer, skip/restore, to top, retry (fresh retry budget and the next free slot), and owner-recorded “indexing requested” / “verified indexed” (only after publishing).
- **Slot math** (`src/lib/workflow/time.ts`): wall times in the slot zone are converted to UTC with an offset search that handles DST gaps (the instant after the gap) and overlaps (the earlier instant); weekdays are evaluated in the slot zone. Unit-tested against Asia/Karachi, Europe/Berlin (both 2026 transitions) and America/New_York.
- **Scheduler tick** (`src/lib/workflow/scheduler.ts`, worker loop every 60 s) **only changes database rows and enqueues jobs**; it never opens a browser:
  - starts articles (one standard task per keyword, idempotency key `workflow-kw:<id>`, source WORKFLOW) within the backlog cap and the write-ahead horizon, each into its own slot: `SlotReservation` is unique per (website, time), so two articles can never share a slot;
  - keywords with an unclear writer wait with “Choose a writer for this keyword.”; Celebrity keywords need the website's default category;
  - syncs each keyword with its task: verified draft → READY; failed → automatic retry up to the cap, then FAILED with the reason; cancelled → SKIPPED; tasks waiting on the owner show why;
  - an article not ready by its slot (or, on publishing sites, a draft not scheduled in time) moves to the next free slot; after the retry cap it stops as FAILED with the reason and frees its slot;
  - draft-only websites: once its slot passes, a verified draft is marked “draft kept (publish yourself)” and leaves the backlog;
  - publishing websites: one `wp.schedule` control job per keyword and slot; after the slot, one `wp.verify-published` job per half hour until WordPress shows the post published.
- **Approved publishing path** (`src/wordpress/schedule.ts`):
  - runs only when the website has publishing switched on **with** the typed acknowledgement; otherwise the draft is not touched and the keyword shows why;
  - schedules the **existing** verified draft as a WordPress “future” post at its slot (`date_gmt`, so WordPress shows it at the right local time), only inside `withPublishPermit` for that post, then reads the post back and requires status “future” and the same minute;
  - never publishes early: a slot less than ~2.5 minutes away moves to the next free slot instead;
  - repeat jobs are no-ops; a post that is no longer a draft is left alone with the reason;
  - after the slot, publication is verified by reading the status back. “future” is re-checked, with a WP-Cron hint after 24 h. A draft goes back to READY for the next free slot. A trashed, deleted or otherwise changed post is left alone and the keyword stops as FAILED.
  - The static publish-guard test now also enforces that `scheduleFuture` (the only `status: 'future'` write) is called only from `wordpress/schedule.ts` and only inside `withPublishPermit`.
- **Indexing:** never claimed by the tool. A Search Console URL Inspection link (for the configured URL-prefix or domain property) appears after publishing; “indexing requested” and “verified indexed” are recorded only from the owner's own actions, and a request is labelled “not evidence of indexing”.
- **Publishing Calendar** (`/calendar`): reserved and free slots of every workflow for two weeks at a time, grouped by day in Pakistan time, with status, article and live-post links, website filter, free-slot toggle and a draft-only notice.
- README and Help: Campaigns and workflow sections.

**Commands run (all passed)**
```
bash scripts/dev-create-migration.sh workflow_search_console_property   # Workflow.searchConsoleProperty (ADD COLUMN only)
npx tsc --noEmit                                           # 0 errors
npx vitest run                                             # 22 files, 169 tests, three consecutive clean runs after the test-DB fix
                                                           # (new: slot math 2, Search Console property 1, scheduler 6; publish-guard scan tightened)
npx vitest run --config vitest.integration.config.ts <file>  # 7 files, 44 tests, run file by file: extension 15, images 6, links 5,
                                                           # drafts 7, session 4, toolchain 1, workflow-publish 6 (new)
npx vitest run --config vitest.integration.config.ts tests/integration/wordpress-session.test.ts
                                                           # 5/5 after the Remember-Me fix (new test fails without the fix: ACTIVE)
WP_E2E_ADMIN_URL=… npm run test:e2e:wordpress               # 8/8 on WordPress 6.7-alpha-58716 and 8/8 on WordPress 6.5.5, fresh disposable
                                                           # databases, first attempt each. New test: with the WordPress clock on
                                                           # Europe/Berlin the existing draft is left alone without permission; with it,
                                                           # it becomes “future” at its slot (date_gmt and Berlin-local date read back),
                                                           # then WordPress's own cron publishes it and the tool verifies it (~208 s)
npm run build                                              # compiled (/workflow, /calendar and the workflow/calendar APIs)
npm run start:all # UI smoke, throwaway data dir, Chromium, real worker: switching on without slots refused (the one 400
                  # in the run); slots 9:00 AM + 3:30 pm added and normalized; next slots shown in Pakistan time and on the
                  # website's clock; 4 pasted keywords → preview leaves the duplicate out → 3 added; the worker's scheduler
                  # started 2 articles into separate slots and flagged “jaguar” for a writer; Tigram chosen → it started
                  # on a later tick; calendar: reserved + free slots per day, draft-only notice, free-slot toggle, next
                  # two weeks, website filter; no console errors other than that deliberate 400
```

**Found and fixed during M10b**
- **Draft-only websites would have stalled.** Verified drafts stayed READY forever and counted against the backlog cap, so after 10 drafts the workflow stopped writing. Once its slot passes, such a draft is now marked “draft kept (publish yourself)” and leaves the backlog.
- **Endless checks on a removed post.** A scheduled post trashed, deleted or changed in WordPress was re-checked every 30 minutes forever. It is now left alone and the keyword stops as FAILED with the reason. A post set back to draft returns to READY for the next free slot.
- **Spec gap:** the per-site Search Console property (URL-prefix or domain) was missing; the inspection link always used the website URL.
- **Retry could leave a keyword stuck.** Retry cleared the slot, so the keyword never came back. Retry now reserves the next free slot, and the tick also gives a slot to any slotless keyword.
- **The “Choose a writer” flag was never shown** while the backlog was full. It is now set right away.
- **A sign-in without “Remember Me” was reported as active.** WordPress then issues a session-only cookie that the browser drops when the login window closes, so the next job found the login page. The login now checks the sign-in cookie and asks the owner to log in again with “Remember Me” ticked. A new integration test fails without the fix. This was found through the WordPress 6.5 e2e run: its first attempt failed in setup (`REST API reachable` expected, the login page shown) because the simulated owner submitted before the page finished loading, i.e. before the app ticked “Remember Me”. This is very likely the unexplained first-run 6.5 setup failure noted in M8. The simulated owner now waits for the page like a person would.
- **Unit test files failed at random** (“table … already exists”) because the test helper applied migrations through a pooled client: the table rebuild in the M9 migration relies on a per-connection PRAGMA. Migrations now run on one connection. Test-only; `npm run setup` uses `prisma migrate deploy` and was not affected.
- The first integration attempt again sat in `extension.test.ts` for over six minutes at low CPU while other test runs shared the machine, and was stopped by hand. Re-run alone: 15/15 in 251 s, and 15/15 again in the final file-by-file run.

**Not verified here**
- Search Console is not automated: the tool never clicks “Request indexing” and never reads index status. The owner opens the URL Inspection link and records “indexing requested” or “verified indexed”. Automating Search Console needs the owner's Google session, so it cannot be tested here.
- WP-Cron on a low-traffic production site can publish late. The tool reports “still future” and adds a hint after 24 hours, but cannot make WordPress publish.
- Live ChatGPT writing the workflow articles was not exercised (scripted answers only).

## M11a — Plagiarism Evidence Checker ✅

**Working**
- **Matching** (`src/lib/plagiarism/match.ts`, `text.ts`, pure and unit-tested):
  - 5-word anchors locate overlaps, which count only as **verified exact runs of ≥ 8 identical words** (extended word by word in the source text);
  - sentences without such a run are compared at **sentence level**: shared content words ÷ the sentence's content words (≥ 70 %, ≥ 6 words) and word order kept (longest common subsequence ≥ 60 %);
  - **quotations** (“…”, „…“, «…», "…", `<blockquote>`, `<q>`) and **recurring site text** (a paragraph found verbatim in ≥ 3 other articles of the same website) are exempt and listed separately;
  - fetched pages are read from their main content; navigation, footers, forms and scripts are dropped.
- **Sources** (`src/lib/plagiarism/sources.ts`):
  - the owner's saved articles on all websites (newest 500, excluding the checked one);
  - pages linked from the article (≤ 10, never the website's own pages) and up to 10 URLs the owner adds;
  - Wikipedia extracts for the topic, through the MediaWiki API (search + plain-text extracts, ≤ 3 articles);
  - **optional** licensed search through Serper. Only when `SERPER_API_KEY` is in `.env`: ≤ 5 distinctive passages as exact-phrase queries, ≤ 8 result pages read. The key goes only to the API in a header and is never logged or stored. Search-engine result pages are never scraped. Without a key, search is reported as “not configured” and everything else works.
  - Every page fetch uses the M7 SSRF-safe fetcher: public addresses only, re-checked on every redirect, size and time caps, no cookies.
- **Result:**
  - side-by-side evidence (your text | source, highlighted), per-source counts, and a coverage list of every source group and page (compared / could not read with the reason / skipped / not configured);
  - the exempt matches, and limitations stated every time: what was not searched, that identical wording does not show who copied whom or whether use is permitted, that near matches can be legitimate, and that no number proves or disproves plagiarism.
  - The counts shown are descriptive (“19 of 94 words in identical runs”, “in 1 of 4 documents compared”); there is **no score or verdict**.
- **Runs:** `PlagiarismCheck` (new table, migration `plagiarism_checks`).
  - Each check is a workflow-queue job run by its own worker loop, one at a time, so slow fetches never hold up campaign queueing. It is restart-safe (an interrupted check starts over) and can be cancelled.
  - Input under 50 words, bad URLs, more than 10 URLs, or no source selected are refused with the reason.
- **UI:**
  - `/plagiarism`: saved article or pasted text; choose sources and extra URLs; history; detail with summary, evidence filter by source, coverage, “Not counted”, limitations and an evidence `.json` export.
  - The article page has a new **Originality** tab (this article's checks plus “Check this article”).
  - README/Help updated; the Editorial Tools hub shows the tool as available.

**Commands run (all passed)**
```
bash scripts/dev-create-migration.sh plagiarism_checks     # PlagiarismCheck (new table only)
npx tsc --noEmit                                           # 0 errors
npx vitest run                                             # 24 files, 179 tests (new: text model + matching 7, end-to-end check 3)
npx vitest run --config vitest.integration.config.ts tests/integration/worker-toolchain.test.ts   # 1/1 (worker with the new loop)
npm run build                                              # compiled (/plagiarism + 4 API routes)
npm run start:all # UI smoke, throwaway data dir seeded with 5 saved articles on 2 websites, Chromium, real worker:
                  # article → Originality tab → “Check this article” (article preselected) → finished: 19 of 94 words in an
                  # identical run with another website's article, side by side; the shared newsletter line exempt as recurring
                  # site text (in 3 other articles); Wikipedia “could not read: DNS lookup failed” (no internet here), search
                  # “not configured”; pasted text → 26 of 61 words in 2 of 5 documents; evidence .json downloaded; text under
                  # 50 words refused (the one 400 in the run); the article tab lists the check; no other console errors
```
The end-to-end test runs against a local fake web: a linked page with a copied sentence and a quote, a reworded page, a JavaScript-only page, a private-address URL, a Wikipedia API and a Serper API that checks the key header. Results: exact runs from the linked page, Wikipedia, another website's saved article and a search result; a sentence-level near match for the rewording; the quote exempt; the call to action exempt as site text; the JavaScript-only page and the private address listed as could-not-read with their reasons; the website's own pages never fetched; the key sent only in the header and absent from the stored result.

**Found and fixed during M11a**
- The summary first said “across 4 sources” while the page showed 1 source with findings: it counted sites whose only overlap was exempt text. It now says “in N of M documents compared”.
- Recurring site text was listed once per article that repeats it. It is now listed once, with the count.

**Not verified here**
- Live Wikipedia, live web pages and the real Serper API (no internet in this environment; local fakes only). Serper's response format is taken from its documentation (`organic[].link`).
- The near-match thresholds (70 % content words, 60 % word order) and the 3-article boilerplate rule are first settings, untested on real articles; they may need tuning.
- German compound words and inflection are matched exactly (no stemming), so reworded German text yields fewer near matches than English.

## M11b — Hardening, diagnostics, accessibility, Windows README, release checklist ✅

**Working**
- **Diagnostics** (`/diagnostics`, `src/lib/diagnostics.ts`, spec §15):
  - **ChatGPT rate limits**: backoff state, last 429/usage limit with the reason, recent 429 count, current concurrency and step, last success.
  - **Extension capabilities** next to its version.
  - **Failing page snapshots**: what the extension saw when a ChatGPT step failed (page variant, composer, send/stop state; no cookies or page text).
  - **Failed stages**, with “Inspect stage” and, where the article has text, “Re-run SEO analysis”.
  - **Checks** that run the real thing: Chrome setup check, extension test prompt (polled to the answer), and a WordPress session test per website (queued for the worker).
  - The downloadable bundle carries all of the above plus the WordPress session states and whether a search key is configured (yes/no only). A new unit test plants a password, cookie, bearer/JWT, a token in a URL, the connection key and search key in logs, snapshots and settings, and checks that none appear in the bundle.
- **Security review** (code read plus the checks below):
  - Response headers: a strict CSP (no third-party origins, `frame-ancestors 'none'`, `object-src 'none'`), nosniff, `X-Frame-Options: DENY`, a referrer policy, a permissions policy and COOP were already in place.
  - SSRF: every fetch of an outside page goes through the SSRF-safe fetcher (link checks, link index, Commons, plagiarism pages and Wikipedia). The exceptions are deliberate: Serper (a fixed API host), the owner's WordPress through the logged-in session, and same-origin browser calls.
  - Path traversal (existing tests), secrets in client bundles (none; only the help-text name `SERPER_API_KEY`), and sharp (all inputs are buffers, so no locked files on Windows) were checked.
  - **Fixed — owner HTML could run script in the editor:**
    - The article editor put unsaved HTML (typed or pasted in HTML mode, or a draft restored from this browser) into the page unsanitized: the visual editor, the compare view and two text helpers that used a detached `div`.
    - Because the CSP allows inline scripts (`'unsafe-inline'`, needed by Next.js's inline bootstrap), inline event handlers could run. Under the app's CSP, `<img onerror>` in a detached `div` did run (checked in Chromium).
    - Now the display goes through DOMPurify with the same allow-list as the server sanitizer (shared `src/lib/html/allowlist.ts`), and the helpers parse with `DOMParser` (inert).
    - After the fix, the same input in the editor ran nothing and the `onerror` attribute was gone. Editing, saving and reloading still work.
  - **`npm audit --omit=dev`** has 5 findings, none fixable without a major upgrade, and accepted:
    - postcss 8.4.31 bundled inside Next.js 15 (4 advisories, plus Next listed for it). It processes only the app's own CSS at build time and never sees outside CSS. The fix is Next 16 (major), deferred.
    - deepmerge-ts < 8 (stack exhaustion on recursive objects) inside the Prisma CLI's config loader (`@prisma/config`), which merges only the local trusted config. Waiting for a Prisma release that updates it.
- **Accessibility**:
  - `npm run audit:a11y` (`scripts/a11y-audit.ts`, axe-core 4.13.0, WCAG 2.0/2.1 A and AA) audits all 21 dashboard pages plus an article page, in light and dark mode, against the running app. It refuses non-local URLs and fails on serious or critical issues.
  - First run: 37 serious violations, all fixed at the source:
    - the sidebar “soon” badge contrast;
    - progress bars without an accessible name (now labelled, e.g. “Progress of <keyword>”);
    - dark-mode contrast of `text-indigo-600` links and some amber and grey text.
  - Second run: **0 violations of any severity** on all 44 page/theme combinations.
- **Windows README**: first-run walkthrough, updating steps, a Windows troubleshooting table (execution policy, port in use, worker lock, Chrome/Edge choice, “Remember Me”, antivirus file locks, extension disconnected, diagnostic bundle), the new script and expanded security notes.
- **`RELEASE_CHECKLIST.md`**: install/upgrade, quality gates, safety rules, owner-PC live checks (including the throughput benchmark), hand-over. Each item says whether it can be checked here or only on the owner's PC.
- New dependencies, exact versions released weeks ago: `dompurify` 3.4.16 (runtime, browser only) and `axe-core` 4.13.0 (dev).

**Commands run (all passed)**
```
npx tsc --noEmit                                           # 0 errors
npx vitest run                                             # 25 files, 180 tests (new: diagnostic bundle redaction 1)
npx vitest run --config vitest.integration.config.ts <file>  # 7 files, 45 tests, file by file, first attempt: extension 15,
                                                           # images 6, links 5, drafts 7, session 5, toolchain 1, workflow-publish 6
npm run build                                              # compiled
npm run audit:a11y   # app running (start:all, throwaway data dir with articles): 1st run 37 serious → fixes → 2nd run
                     # “No serious or critical violations”, 44/44 page+theme combinations without any violation
npm audit --omit=dev # 5 findings, all requiring major upgrades, accepted with reasons above
npm run start:all # smokes in Chromium against the built app + real worker:
                  # Diagnostics: rate-limit card, “Check Chrome setup” (real result: Chrome not installed in this sandbox),
                  # “Test extension connection” queued and waiting for the extension, “Test session” queued for a website,
                  # bundle downloaded — 17 sections, no cookie or key pattern inside;
                  # editor: <img onerror> + <p onclick> typed in HTML mode, compare + visual views → handler never ran,
                  # onerror stripped; visual typing → HTML mode → Save edits → reload shows the edit; no console errors
```

**Not verified here**
- The live checks in `RELEASE_CHECKLIST.md` §4 (real ChatGPT, real WordPress sites, Rank Math, live web sources, backup/restore on the owner's PC) and the **throughput benchmark** (≥ 6 verified drafts/hour). They need the owner's accounts and internet.
- The CSP still allows inline scripts (`'unsafe-inline'`) because the Next.js bootstrap needs them. A nonce-based CSP would require rendering every page dynamically and is not done. HTML is sanitized before display instead.
- Screen-reader testing by a person (axe only finds what can be detected automatically).

## M12 — Duplicate Content Detector, unified quality report, router rules ✅

**Working**
- **Duplicate Content Detector** (upgrade 07; `src/lib/duplicates/`):
  - **Before drafting** (DUPLICATE_PRECHECK, before any ChatGPT prompt):
    - an exact or near-duplicate keyword on the same website (word order, plurals, small typos; different numbers stay different) pauses for review unless the owner allows a separate version;
    - a published post on the same website whose title covers every content word of the keyword becomes a warning;
    - the same keyword on other websites is noted, and their wording is compared at the quality gate.
  - **At the quality gate**: the article is compared with every saved article on all websites (newest 500) using the plagiarism matcher (verified identical runs of 8+ words, sentence-level near matches, identical paragraphs).
    - Runs made mostly of names, dates and numbers are counted as **shared facts**, not duplication, so two articles about the same person do not trip it. Text that recurs across the website (in 3+ other articles) is exempt.
    - Severity: **HIGH** = at least 45 % of the words in duplicated runs (setting `duplicateSimilarityReview`), a 60-word identical run, or 3 identical paragraphs; **MEDIUM** = a third of that share, a 25-word run, 1 identical paragraph, or 4 similar sentences; **LOW** otherwise.
    - HIGH stops the article before WordPress (hard stop `DUPLICATE_WORDING`); MEDIUM is a review warning; LOW is only recorded.
    - Paragraph fingerprints (`ContentFingerprint`) and every overlap with its evidence (`DuplicateMatch`) are stored.
  - **Duplicate Review** (`/duplicates`):
    - overlaps side by side (identical wording / similar sentence / shared facts) with counts and the other article and website;
    - actions: keep with a reason (at least 10 characters, audited `duplicate.override`, the paused article continues from the quality gate), write the text again (regenerates the writing stage), edit it yourself, or withdraw an override;
    - nothing is deleted or rewritten automatically.
- **ArticleQualityReport** (upgrade 12; `src/lib/quality/report.ts`):
  - one stored record per evaluation: the gate's hard stops and warnings, each linked to its source stage, plus per-area evidence (SEO readiness and unmet checks, structure, research sources/uncertainty, duplicates, links, images);
  - a second record after the WordPress step adds the draft read-back and Rank Math values as read from the editor;
  - status PASS / REVIEW / BLOCKED, shown as a **Quality report** card on the article Overview. Nothing is computed to make a check pass.
- **Smart Article Router — website rules** (upgrade 05):
  - per-site rules (“keyword contains *phrase* → writer”, whole words, case-insensitive, at most 50, de-duplicated, audited `website.routing-rules`);
  - precedence: the row's own choice > campaign default > website rule > classifier (UNKNOWN still asks you);
  - used by Bulk Campaigns and the workflow, which now store the decision source (`SITE_RULE`); invalid stored rules never route;
  - a **Writer rules** card on the website page with a “Try a keyword” preview; only the two active writers can be chosen.
- **Upgrade safety**: migration `duplicates_quality_reports` adds three tables and a `Website` column, which makes Prisma rebuild the `Website` table (copy, drop, rename).
  - Verified on a copy of a real smoke database (4 websites with categories, workflows, keywords, slot reservations, link targets and tasks): `npm run setup` took a backup, applied it, and left every row count identical, with no foreign-key violations.
  - A new integration test (`migration-upgrade`) repeats this with the real `prisma migrate deploy` for the latest Website rebuild.
- Test helper: scripted ChatGPT answers give every article identical text, which the detector rightly pauses. The test driver therefore records the owner's override (same path, with that reason) unless a test opts in with `detectDuplicates`. The new duplicate tests opt in.

**Commands run (all passed)**
```
bash scripts/dev-create-migration.sh duplicates_quality_reports   # 3 new tables + Website.routingRules (Website table rebuilt)
npm run setup  # on a copy of the M10b smoke database seeded with categories and link targets: backup written, 2 migrations
               # applied, Website 4 / Category 4 / Workflow 4 / WorkflowKeyword 12 / SlotReservation 11 / LinkTarget 4 /
               # ArticleTask 11 / ArticleStage 45 / QueueJob 14 / AuditLog 16 rows before and after; foreign_key_check empty
npx tsc --noEmit                                           # 0 errors
npx vitest run                                             # 27 files, 192 tests (new: comparison + router rules 8, pipeline 4)
npx vitest run --config vitest.integration.config.ts <file>  # 8 files, 46 tests, file by file, first attempt (new: migration-upgrade 1)
npm run build                                              # compiled
npm run start:all # UI smoke, throwaway data dir: two articles on two sites seeded with the real duplicate check + report;
                  # /duplicates: heavy overlap “98 % … longest run 265 words · 8 identical paragraphs”, passages expand,
                  # “Keep” disabled until a reason is typed, kept → “Kept by you” with the reason, withdraw → back to open;
                  # article Overview: Quality report “stopped before WordPress” with the hard stop; website Writer rules:
                  # rule added, “Try a keyword” → Celebrity Article Writer “Website rule: keyword contains ‘net worth’”,
                  # saved and still there after reload; no HTTP or console errors
npm run audit:a11y                                         # 46/46 page+theme combinations without any violation (incl. /duplicates)
```
Pipeline tests through the real engine:
- A second article repeating the first's wording stops at the gate as `DUPLICATE_WORDING`, before any WordPress call. One HIGH match with the evidence, fingerprints stored, report BLOCKED.
- A 2-character reason is refused. A proper reason is audited and the article continues to the WordPress step; the report records the override, and withdrawing it reopens the match.
- A near-duplicate keyword pauses at the precheck without a single ChatGPT prompt. A published post covering the keyword is a warning. The other website's identical wording is still caught at the gate, naming that website.
- A campaign preview routes by the website rule.

**Not verified here**
- How often real ChatGPT articles about the same person cross the thresholds. The fact-like rule (≥ 30 % names/dates/numbers in a run of ≤ 20 words) and the HIGH/MEDIUM thresholds are first settings and may need tuning on real output.
- Published posts not written by this app are compared by title only: their body text is not in the link index.

## M13 — Research & Fact Checker evidence ledger, intelligent internal linking ✅

**Working**
- **Evidence ledger** (upgrade 03; `src/lib/research/`), built in the celebrity RESEARCH_EVIDENCE stage (no extra ChatGPT prompt):
  - The research notes are split into **checkable claims**: birth, death, family/relationship, education, award, net worth, career. Each claim records its values: dates in English/German formats normalised to YYYY-MM-DD / YYYY-MM / YYYY, amounts, and names. It also records its nature (reported fact, estimate, or unverified claim/rumour) and its cited URLs. Birth, death, family and net worth count as **high impact**.
  - Every cited page is fetched with the SSRF-safe fetcher and stored as a `SourceRecord`: OK, DEAD, BLOCKED, NOT_HTML or FAILED, with the fetch time. Records are cached for 7 days; “Re-check sources” fetches them again.
  - A page counts as evidence only when it is **about the same person**: the name must appear, plus one context word from the notes (occupation groups with English/German equivalents; words inside URLs are ignored). Namesakes and disambiguation pages are not used, and are listed as off-topic.
  - Each source is judged per claim as supports / contradicts / no mention, with an excerpt. Claim status:
    - **VERIFIED** only with 2+ independent supporting sites;
    - **SINGLE_SOURCE**, **ESTIMATE**, **DISPUTED** (rumour);
    - **CONTRADICTED** (a source gives a different value; this is never hidden by other support);
    - **UNVERIFIED**.
  - Conflicting values inside the notes themselves (two birth dates) are surfaced.
  - Results are stored as `ClaimEvidence` rows.
- **Quality gate** (the `evaluateArticleEvidence` evidence section of the ArticleQualityReport):
  - **Hard stop**: research notes leaking into the article (raw URLs, “Sources:”, “research notes”).
  - **Review warning**:
    - a contradicted high-impact claim;
    - a high-impact claim that appears in the article without support (located by its values or names).
  - **Notes only**: dead or off-topic sources, and having no checkable sources at all.
- **Research Evidence page** (`/research-evidence`):
  - articles with claims to check; the claim list with status, sources, excerpts and the contradiction detail (“source gives 1989-10-01, the notes say 1989-09-01”);
  - every source with its status and fetch time.
  - Owner decisions, audited `research.decision`:
    - accept as it is;
    - leave it out of the article;
    - correct the value (a note of at least 5 characters is required; save stays disabled until then).
  - Decisions are keyed by the claim's signature, so they survive a rebuild and resolve the matching review reason; clearing a decision is also supported.
  - “Re-check sources” runs as a workflow job (`research.recheck`). “What changed since the last research” compares with the previous ledger of the same keyword.
- **Intelligent internal linking — stored decisions** (upgrade 06, on top of the M7 index and anchors):
  - every contextual-link decision is stored in `SuggestedInternalLink`:
    - the line link (SELECTED);
    - related posts placed in the body (SELECTED, with the anchor);
    - related posts not placed because the per-article limit was reached (PROPOSED, with the anchor that would be used);
    - no natural anchor, or only the focus keyword (NO_ANCHOR);
    - unreachable (UNREACHABLE, with the reason);
    - the top unrelated candidates (NOT_RELATED);
  - shown as “Contextual link decisions” on the article Links tab. Each run replaces the task's rows (at most 40).
- Migrations: `research_evidence` (SourceRecord, ClaimEvidence) and `internal_link_suggestions` (SuggestedInternalLink). Both are CREATE TABLE only, with no table rebuild.

**Commands run (all passed)**
```
bash scripts/dev-create-migration.sh internal_link_suggestions
npx tsc --noEmit                                           # 0 errors
npx vitest run                                             # 29 files, 206 tests (new: claims 8, ledger 6 on a local fake web)
npx vitest run --config vitest.integration.config.ts <file>  # 8 files, 46 tests, file by file, first attempt
                                                           # (links test now also checks the stored decisions:
                                                           # line SELECTED, unrelated post NOT_RELATED, one website only)
npm run build                                              # compiled
npm run setup + seed + npm run start:all  # UI smoke on a throwaway data dir: celebrity task with notes and three cached
                  # sources (one contradicting the birth date); /research-evidence lists it (1 sources disagree,
                  # 1 disputed / rumour, 1 estimate, 1 one source); contradiction detail shown; “Leave it out” saved
                  # only after a note; “Re-check sources” → this container has no internet, so all three sources
                  # became DEAD (“DNS lookup failed”), shown honestly; the owner decision was kept after the rebuild;
                  # no HTTP or console errors
npm run audit:a11y                                         # 48/48 page+theme combinations, no violations (incl. /research-evidence)
```
Unit tests through the real ledger on a local fake web:
- **Two independent sources** → VERIFIED. Estimates and rumours stay separate; dead links are notes.
- **Caching**: sources are cached for a week; a re-check fetches them again.
- **Conflicts and leaks**:
  - conflicting birth dates are surfaced;
  - an unsupported relationship claim in the article is a warning;
  - leaked notes are a hard stop.
- **No wrong-entity merge**: a TV presenter with the same name and a disambiguation page are not used as evidence for the musician.
- **Owner decisions**: a correction keeps the source links, survives a rebuild and resolves the review reason.
- **Stale facts**: changes since the previous research of the same keyword are listed.

**Not verified here**
- **Live sources**: real third-party pages, including Wikipedia, are not reachable from this container. The “about the same person” rule and the support/contradiction judgement are first settings, tested only on fixture pages.
- **Claim extraction** uses patterns on the research notes, not a language model. Claims worded in unusual ways are not extracted; they are not invented either.
- **Not used for linking yet**: the `Website.linkStrategy` column is still not used, and contextual anchors ignore headings (the anchor is the target post's own phrase found in body text).

## M14 — Image Studio and WordPress manager hardening ✅

**Working**
- **Alt text** (upgrade 08; `src/images/alt-text.ts`), applied to every rendered image before it is stored:
  - “Image of …” / “Bild von …” is dropped (“Photo of …” stays, it says what kind of image it is);
  - text over 125 characters is shortened at a word boundary;
  - file names (`IMG_2041.jpg`, `DSC_0042`), web addresses, one-word labels, a repeated keyword and the same text on two images are replaced with a neutral text: the article title for the featured image, “*Subject*: article image 2/3” for body images (German: “Artikelbild”). It never claims to know what an image shows;
  - every change is listed in the image notes. Alt text the owner edits in the article wins over the stored one.
- **Media uploads happen once**, even when an answer is lost (`src/wordpress/media.ts`):
  - each image is uploaded under a unique name (file name + asset tag), so its WordPress slug is known in advance;
  - `uploadStartedAt` is set before the upload and cleared with the answer. If it is still set on a retry, the Media Library is searched for that slug and a hit is adopted instead of uploading again;
  - one immediate retry per image; an image that still fails is left out of the draft with a note (featured image included — before, a failed featured upload failed the whole save); the text is always saved;
  - missing alt text on an adopted or reused WordPress item is filled in.
- **Site health** (upgrade 09; `SiteHealthObservation`, `src/lib/site-health.ts`), measured results only, kept 30 days:
  - recorded by session tests, the login window, editor detection, every draft save (with duration and outcome) and every upload run;
  - the website page's **Site health** card: overall healthy / needs attention / failing / no data yet with the reasons, the latest result per check, the last 24 hours (saves, failures, median save time) and recent observations;
  - a later successful save clears an older session/REST/permission *failure*; it does not clear a warning such as “may not upload images”.
- **Account permissions**: the session test reads `/wp/v2/users/me` (the account's own roles and capabilities):
  - may not create posts → failing;
  - may not upload images, or may not create tags when tag creation is on → warning;
  - a draft refused by WordPress (`rest_cannot_create`) stops with that reason and is recorded.
- **Session detection**: WordPress's own “session expired” pop-up (wp-auth-check) now counts as logged out, verified against the real markup of WordPress 6.7 and 6.5. In real WordPress the pop-up's wrapper has no size of its own, so the dialog box inside it is what is checked. The hidden pop-up present on every admin page does not count.
- **Batch re-save**: the Site health card lists the articles stopped at a WordPress step (draft, Rank Math, verification) with the error.
  - **Re-save selected** gives each one the WordPress tab's “Save to WordPress again”: the stored draft is reopened (never duplicated), reasons from the WordPress steps are re-evaluated, and a draft edited in WordPress still stops for the owner's decision.
  - It is refused while the site is paused or logged out; only listed articles can be re-saved; audited `wordpress.batch-resave`.
- **Change preview for conflicts**: when a draft was edited in WordPress, the WordPress version is captured at that moment. The article's WordPress tab shows **Changes made in WordPress**: the text blocks only in WordPress (what “Overwrite” would replace) and only in the app, compared without markup.
- Migration `site_health_media_upload_marker`: one nullable column and one new table, no table rebuild.

**Commands run**
```
bash scripts/dev-create-migration.sh site_health_media_upload_marker   # ALTER TABLE ADD COLUMN + CREATE TABLE (no rebuild)
npx tsc --noEmit                                           # 0 errors
npx vitest run                                             # 30 files, 215 tests (new: alt text, permissions, upload names,
                                                           # site health incl. pruning and superseding, version comparison)
npx vitest run --config vitest.integration.config.ts <file>  # 8 files, 49 tests, file by file
                                                           # (new: lost upload answers + alt text; permissions, health and
                                                           # the expired pop-up; no-permission draft + batch re-save)
npm run build                                              # compiled
npm run setup + seed + npm run start:all  # UI smoke on a throwaway data dir: WordPress tab “Changes made in WordPress”:
                  # 2 blocks only in WordPress, 1 only in the app; website Site health: needs attention, reasons
                  # “Account permissions: … may not upload images …” and “1 media upload(s) failed”, last 24 h line,
                  # 1 article stopped at a WordPress step; Re-save disabled with nothing selected; Re-save → queued →
                  # the worker ran the WordPress step, which failed here because this container has no Google Chrome
                  # (“Chromium distribution 'chrome' is not found”) and was recorded as a failed draft save;
                  # no HTTP or console errors
npm run audit:a11y                                         # 50/50 page+theme combinations, no violations (now also a
                                                           # website page and an article page)
WP_E2E_ADMIN_URL=… npm run test:e2e:wordpress              # WordPress 6.7-alpha: 9/10, WordPress 6.5.5: 9/10 (fresh databases)
WP_E2E_ADMIN_URL=… npx vitest run --config vitest.e2e.config.ts -t "session expired"   # after the fix: 1/1 on 6.7 and on 6.5
```
The real-WordPress run found a bug in the new pop-up detection. Real WordPress 6.7 and 6.5 show the session-expired pop-up with a zero-size wrapper, and the first version checked only that wrapper, so the real pop-up was not recognised. Fixed: each selector is now checked on its own, and the dialog box counts. The fake WordPress now mimics this layout, so the integration test would catch the old behaviour. The other new real-WordPress test passed on both versions on the first run: WordPress derives the predicted slug from the upload name, the lost upload is adopted, and only one media item exists.

The smoke's first seed attempt failed: the script tried to update a stage the engine had not created yet. Fixed in the seed (all stages before the WordPress step are created and marked done); app code was not involved.

**Not verified here**
- **Owner's setup**: the owner's Chrome profile, live WordPress sites (hosting overlays, security plugins, real Editor/Author accounts) and real timeouts during uploads. The lost-answer path is tested with a fake that drops the connection, and on real WordPress by simulating the lost answer.
- **Concurrent uploads**: an upload that WordPress finishes *after* the retry's slug lookup could still produce a second copy. The retry waits 1.5 s first; nothing else guards this.
- **Alt text**: the fallback text is generic by design; descriptive text still comes from the image plan, the photo check or the owner.

## M15 — Search Performance (verified data only) and Content Refresh ✅

**Working**
- **Search Performance** (upgrade 10; `src/lib/search-performance/`, `/search-performance`):
  - **Only owner-exported Search Console data**: Performance → Export → Download CSV, uploaded here as the zip or its CSV files. Nothing is fetched from Google, scraped or estimated.
  - Reads English and German exports, compare exports (both periods), Pages/Queries/Dates/Filters; other tables (countries, devices) are listed as not used. The zip reader is bounded (entry count, sizes, declared size checked, no ZIP64/encryption); numbers in EN/DE notation; formula-like CSV cells are escaped on export.
  - **Honest states**: no property → **NOT CONNECTED**; property but nothing imported → **NO VERIFIED DATA** (no numbers shown).
  - **Refused**: pages of another property (domain or URL-prefix), search types other than Web, a missing period (no Dates.csv and no dates entered), and the same export twice. Removing an import is audited.
  - **Trends**: 7/28/90-day windows with how many days have data; a change only when both periods are complete. Days are Search Console's Pacific-Time calendar days as exported, counted with UTC date arithmetic (tested across DST changes).
  - **Pages and queries**: the latest reports, with pages matched to the app's articles (host without www, path without trailing slash).
  - **Declining pages**: at least 10 clicks before and at most 70 % now, from a Compare export or the previous report of the same length.
  - **Published articles without impressions**: articles at least 14 days old at report end. Not counted when the page export hit the 1,000-row cap, because absence from a capped list proves nothing.
  - **Indexing**: requests (workflow), confirmed by the owner, and seen in search (impressions in imported data) are counted separately; a request is never indexing.
  - CSV exports for pages, queries, declining and zero-impression lists.
- **Content Refresh** (upgrade 11; `RefreshCandidate`, `ContentRevision`, `src/lib/refresh/`, `src/wordpress/refresh-apply.ts`, `/content-refresh`):
  - **Evaluation is read-only**: daily per active website (idempotent per day), or **Evaluate now**; it runs in the evidence-job loop.
  - **A candidate needs evidence**:
    - a past edition year in the title or a heading, or “as of / Stand: <year>” (birth or wedding years in sentences never count);
    - a dead link (HTTP 404/410; a missing domain only when other links in the run answered, so an offline PC does not report dead links — it says so);
    - a contradicted high-impact claim from the evidence ledger;
    - falling clicks or zero impressions from imported Search Console data.

    Age alone never creates a candidate, it only adds priority, so a current evergreen article is left alone. Re-evaluation updates instead of duplicating, resolves fixed articles, and keeps a dismissal unless the evidence changes.
  - **Revision**: a separate record proposed from the article's current text, with dead links unlinked (words kept) and the passages to update named. The owner edits the HTML (sanitized) and sees removed/new text blocks before approving. An unchanged revision cannot be approved, nor one whose article changed in the app meanwhile.
  - **Approval → the SAME WordPress post** (control job `wp.refresh-apply`):
    - only `content` is sent; status, date, slug and URL stay, and the read-back checks it (a changed state would open a critical recovery incident);
    - drafts are updated directly;
    - live posts need the site's “approved updates to live posts” switch (canPublish + typed acknowledgement, existing card) AND the typed `UPDATE LIVE POST`; it is checked again at apply time, so a post that went live after approval is **blocked**;
    - edits made in WordPress since the app's last save stop it as **CONFLICT** with nothing changed. **Start from the WordPress version** adopts that text (the app's text stays in the history) and proposes again;
    - a failed attempt (e.g. logged out) goes back to approved with the reason, the queued job retries, and the owner can **try again** or reject;
    - the local article changes only after WordPress confirmed the update; a retry after a crash finds the content already there.
  - **Rollback** proposes the previous text through the same approval and apply path. Everything is audited (`refresh.*`).
- Sidebar: Content Refresh and Search Performance are no longer marked “soon”.
- Migration `search_performance_content_refresh`: four CREATE TABLE statements, no table rebuild.

**Commands run**
```
bash scripts/dev-create-migration.sh search_performance_content_refresh   # 4 × CREATE TABLE, no rebuild
npx tsc --noEmit                                           # 0 errors
npx vitest run                                             # 33 files, 236 tests (new: zip/parser/trends/signals 9,
                                                           # Search Performance 6, Content Refresh 6)
npx vitest run --config vitest.integration.config.ts <file>  # 9 files, 54 tests, file by file, all on the first attempt
                                                           # (new: content-refresh 5 against the fake WordPress)
WP_E2E_ADMIN_URL=… npm run test:e2e:wordpress              # 11/11 on WordPress 6.7-alpha and 11/11 on 6.5.5, fresh
                                                           # databases (new: refresh of the now LIVE post)
npm run build                                              # compiled
npm run setup + seed + npm run start:all  # UI smoke on a throwaway data dir (see below)
npm run audit:a11y                                         # 54/54 page+theme combinations, no violations
```
- **Integration** (fake WordPress), through the real worker code:
  - a draft gets only `content` (request body checked), keeps status/date/slug/title, and the local text changes afterwards; a retry finds it applied;
  - a post that went live after approval is BLOCKED, then updated with permission and the typed acknowledgement, with status `publish` and its date unchanged;
  - an edit made in WordPress gives CONFLICT with nothing changed; continuing from the WordPress version applies cleanly and keeps the editor's paragraph;
  - a rollback restores the text;
  - an update while logged out goes back to approved with the reason, a second approval is refused while the job is queued, and it applies after login.
- **Real WordPress** 6.7 and 6.5: on the post WordPress itself published in the scheduling test, the refresh is refused while the site does not allow live updates. With permission it changes only the content (status, `date_gmt`, slug and link identical when read back), and a later edit made in WordPress stops the next refresh with nothing changed.
- **UI smoke** (Chromium, built app + real worker):
  - NOT CONNECTED for the site without a property, NO VERIFIED DATA (no numbers) before the import;
  - the fixture zip import, then the 7-day card “70 clicks −50 %”, the zero-impression list, the pages table linked to the article, the CSV export, and a duplicate import refused;
  - Content Refresh: two candidates with “Outdated year”, the evergreen article not listed;
  - proposed, edited and compared;
  - live post: approval refused with the reason;
  - draft: approval queued; the worker's attempt failed because this container has no Google Chrome, which is shown as “The update did not run: …”;
  - no console errors except the two deliberate 409 refusals.

The audit found one dark-mode contrast problem in existing code: job errors on the website page. Fixed.

**Not verified here**
- **Real Search Console exports**: no real Search Console account is available. The parser follows the export's column names (English and German, normal and Compare) and was tested on fixtures written to match. Unknown column names are reported as files not used rather than guessed.
- **Indexing**: a URL Inspection API or automated indexing checks are not built.
- **Content refresh text**: there is no ChatGPT-assisted rewrite. The owner writes the new text; only dead links are fixed automatically.
- **Freshness wording**: only the listed marker phrases are recognised.

## M16 — Productivity analytics, Website Control Center, recovery and the benchmark report ✅ (live benchmark NOT RUN)

**Working**
- **Productivity Analytics** (upgrades 01 and 15; `src/lib/analytics/`, `/productivity`):
  - **Evidence only**:
    - a verified draft is the `ARTICLE_VERIFIED` metric written once per article when its WordPress draft was read back and verified, with the post ID and edit URL as proof;
    - stage times are `STAGE` metrics;
    - unique metric keys mean retries and restarts never count twice (tested by recording the same event again);
    - metrics now carry the app version, so stage medians can be compared per release.
  - **Throughput**:
    - rolling 15/60/120-minute counts and rates (window boundaries tested to the second);
    - a 14-day trend in Pakistan days;
    - 7-day totals by website, writer and campaign;
    - the latest verified drafts with their WordPress posts.
  - **Where time goes**:
    - the slowest stages (p50/p90 by nearest rank, retries, failures) and the whole-article median/p90;
    - ChatGPT limits (24 h) and time in backoff;
    - review/approval/paused load, quality-gate results (7 days) and the top reasons articles stopped;
    - CSV of verified drafts and of stage timings.
  - **Target vs actual**: 6 verified drafts in EACH of the last two consecutive hours.
    - PASS or FAIL;
    - **claim suspended** when ChatGPT limits, a login/check pause or a stopped worker interfered (“target temporarily unattainable: …”);
    - **no work to measure** when nothing was queued.

    The capacity figure (slots × 60 ÷ measured median minutes per article) is labelled as an estimate.
  - **Alerts**: worker not running, an article job waiting 15+ min past its start time (queue stall), ≥ 30 % failed stage runs in the last hour (at least 5 runs), ChatGPT backoff.
  - **Speed profiles**: the existing high-throughput (3 adaptive slots, 1–5, halved on 429s) and quality-first (1 slot) profiles are shown with the current slot count. Both pass the same quality gate. The profile is chosen in Settings.
- **2-hour benchmark report** (`npm run benchmark:report -- <start>`; `src/lib/analytics/benchmark.ts`): for the owner's live test, from stored evidence only.
  - It lists:
    - the verified articles of each hour with their WordPress post and edit URL, minutes from start, ChatGPT interactions and per-stage times;
    - stage p50/p90 and retries in the window;
    - articles stopped or failed in the window;
    - logged pauses, ChatGPT limits, and the app/Node/worker/extension versions;
    - the PASS / FAIL / SUSPENDED / NO_WORK verdict.
  - It is saved as Markdown in `data/reports/`, and the exit code is 0 only on PASS.
- **Website Control Center** (upgrade 14; `src/lib/website-control.ts`, `/website-control`):
  - **One grid**: every website with language, time zone, WordPress session, measured health (M14), categories and default category, editor, internal-link line and index size, image template, prompt overrides, writer rules, Rank Math mode/target, workflow, Search Console property, publishing permission and article counts (incl. verified in 7 days).
  - **Per-site controls** (validated, audited `website.controls`):
    - **Pause/Resume** — the dispatcher starts no new articles for a paused site;
    - **Priority** (−10…10);
    - **Max in progress** (0 = no limit) — the dispatcher's per-site quota.
  - **Check all sessions** queues one session test per active site (never two at once for a site).
  - **Copy safe settings** (audited):
    - copied: overrides, writer rules, the Rank Math target, and the image design without the source's logo and fixed photos;
    - between sites of the same language only: the internal-link line and prompt overrides (skipped with the reason otherwise);
    - never copied: URLs, the WordPress profile, categories, publishing permission, the Search Console property and pause/priority.
  - **Isolation tests**: the same WordPress category ID on three sites — a task cannot use another site's category; publishing permission on one site stays off on the others; German/English text never crosses.
- **Recovery Center**: stalled articles (running, no update for 30+ minutes) get **Resume from <stage>**, continuing from the saved checkpoint without resetting finished stages. Open incidents already offered resume/retry (M2).
- **Search intent and SEO brief** (upgrade 04, the part that was missing; `src/lib/seo/intent.ts`, article SEO tab):
  - **Intent**: deterministic EN/DE rules classify each keyword as biography, family/relationship, net worth estimate, explainer, comparison or how-to, with the reason and a confidence.
    - Two person names → relationship.
    - Surnames such as “Mann” do not count as family words.
  - **Brief**: sections to cover in the article language, title/meta guidance, the FAQ focus, and the keyword guideline (a density guideline, “never repeat it unnaturally”). For net worth, figures are marked as estimates.
    - Stored when the task is created (`ArticleTask.seoBrief`).
    - Editable on the SEO tab (validated, audited `task.seo-brief`), with a reset to the suggestion.
  - **Use**: appended to the LONG_ARTICLE / ARTICLE prompt unless the template places `{{seo_brief}}` itself.
    - Setting “Add the SEO brief to writing prompts”, default on.
    - Saved prompts are not changed.
  - **Check**: an `info` SEO check shows which brief sections appear as headings. It never changes the score, and the gate ignores info checks.
- Production metrics carry the app version (per-release stage baselines on the Productivity page).
- Sidebar: no “soon” pages are left.

**Commands run**
```
bash scripts/dev-create-migration.sh article_seo_brief     # ALTER TABLE ArticleTask ADD COLUMN seoBrief (no rebuild)
npx tsc --noEmit                                           # 0 errors
npx vitest run                                             # 37 files, 254 tests (new: measurement + report 7, Website
                                                           # Control 4, benchmark report 2, search intent / SEO brief 5)
npx vitest run --config vitest.integration.config.ts <file>  # 9 files, 54 tests: 8 files passed on the first attempt;
                                                           # extension 14/15 (see below), 15/15 after the harness fix
npm run build                                              # compiled
npm run setup + seed + npm run start:all  # UI smoke on a throwaway data dir (see below)
npm run audit:a11y                                         # 58/58 page+theme combinations, no violations (now incl.
                                                           # /productivity and /website-control)
npm run benchmark:report  (smoke data dir)                 # Markdown report saved to data/reports/, verdict FAIL for the
                                                           # seeded 2 + 3 drafts, exit code 1
WP_E2E_ADMIN_URL=… npm run test:e2e:wordpress              # final: 11/11 on WordPress 6.7-alpha and 11/11 on 6.5.5 (fresh databases;
                                                           # two earlier runs hit test-harness races, see below)
```
- **Extension integration, first run**: one test failed before any prompt was sent. Playwright reported the extension's service worker before its `chrome.storage` API was bound (“Cannot read properties of undefined (reading 'local')” while pairing). This is a startup race in the test helper, not in the app. The helper now waits up to 15 s for the API; the whole file then passed 15/15.
- **Real WordPress e2e, three runs.** Both failures were races in the test harness; no app code changed.
  1. **6.7: 0/11 (all skipped); 6.5: 11/11.** The setup failed with `LOGIN_REQUIRED`.
     - The PHP built-in server is single-threaded. A `wp-cron` loopback held it for 35 s, so the login page appeared late.
     - The test's simulated owner checked for the login page once, after 1.5 s, and gave up. Nobody typed until the 90 s login window closed; the PHP log shows no login POST.
     - Fix: the simulated owner now waits for `wp-login.php`.
  2. **6.7: 10/11; 6.5: 11/11.** The “session expired” test timed out after 60 s.
     - The test runs as soon as the admin bar exists, which is before the footer scripts load. Its `wp.heartbeat.connectNow()` therefore did nothing.
     - The next regular dashboard heartbeat came 58 s later, too late for the test's 60 s wait.
     - Fix: the test waits for `heartbeat.js` and page load before dropping the cookies.
  3. **Final, fresh databases: 6.7 11/11 and 6.5 11/11**, at the commit with both fixes.
- **UI smoke** (Chromium, built app + real worker):
  - **Productivity**:
    - last 15/60/120 min = 1/3/5 verified (4, 3 and 2.5 per hour);
    - target vs actual “FAIL — 2 and 3 verified drafts…” with both windows listed;
    - slowest stage LONG_ARTICLE (p50 6.0 min, p90 7.0 min);
    - by website Celeb News 4 / Promi Welt 2; 6 proof rows;
    - the CSV has 6 rows.
  - **Website Control**: 2 cards; pause → “paused” shown; quota saved; copy EN → DE skipped the internal-link line because the language differs; session tests queued for 2 of 2 sites.
  - **Recovery Center**: “Resume from LONG_ARTICLE” on an article idle for 45 minutes → “Resuming from LONG_ARTICLE.”
  - No console errors.

  The first seed gave the idle article a status that does not exist (`GENERATING_ARTICLE`), so the page rightly did not list it. Corrected in the seed (`WRITING_ARTICLE`); no app change.

**Benchmark: NOT RUN.** The owner-authorized 2-hour live benchmark (6 verified drafts in each consecutive hour) needs the owner's signed-in ChatGPT, the paired extension and real WordPress sites. None of these exist in this container.
- No PASS or FAIL is claimed for the real target.
- The tooling to measure it is built and tested: the Productivity page and `npm run benchmark:report`.
- RELEASE_CHECKLIST §4 says how to run it and where to record the result.

**Not verified here**
- Real throughput, real stage timings, ChatGPT 429 behaviour and Chrome health under load; all figures above come from seeded or scripted runs.
- How well the intent rules match real keywords, and whether the appended brief improves real ChatGPT articles.
- Chrome memory/health as a signal for the adaptive slots: not measured. Slots adapt to ChatGPT 429s, as since M2.

## After M16 — first run on the owner's PC: TITLES stopped as “uncertain” (fixed; extension 3.1.1)

**Reported by the owner** (Windows, Node 26.12.0, Google Chrome; console output pasted into the session):
- `npm install`, `npm run setup` (15 migrations, 14 prompts, Chrome and Edge found), `npm run build` and `npm run start:all` worked.
- Automation Chrome launched and extension 3.1.0 connected.
- On a German site, the owner signed in to WordPress in the visible window. The app then detected Gutenberg, synced 9 categories and reported the session ACTIVE with Rank Math detected.
- The first Single Article stopped right after the TITLES prompt was sent. It went to **Needs review** with “UNCERTAIN: The app recorded this prompt as sent, but it is not visible in this conversation”.
- The article's **Retry** did not help (see below).

**Cause 1 — the extension gave up on a reloaded page too early.** Reproduced here.
- When the ChatGPT page reloads during a job, the extension restarts the job and first looks for the prompt it already sent, so it never sends it twice.
- It looked once, as soon as the composer appeared. The real ChatGPT shows the composer before the conversation's turns, so the prompt was not there yet.
- The fake ChatGPT now has an option that renders the turns 6 s after the composer. With the old extension, the new test fails with the owner's exact error. With 3.1.1 the extension keeps looking for up to 30 s, finds the prompt and recovers the answer; the fake counts one send.
- Why the page reloaded on the owner's PC is **not known yet**. The failure snapshot from Diagnostics was requested.

**Cause 2 — Retry after an uncertain prompt sent nothing.** Retry reset the stage to the same operation, which found the same uncertain prompt and stopped for review again; a new unit test failed this way. Retry is now the owner's decision to send again:
- the uncertain prompt is kept as history (SUPERSEDED);
- its Recovery Center incident is resolved;
- a fresh prompt is sent once.

**Also (test only)**: the backoff assertion in `tests/unit/engine.test.ts` compared with the current time and failed once on a loaded machine. It now measures from the failure.

**Commands run**
```
npx tsc --noEmit                                           # 0 errors
npx vitest run                                             # 37 files, 255 tests (new: Retry after an uncertain prompt)
npm run build                                              # compiled
npx vitest run --config vitest.integration.config.ts tests/integration/extension.test.ts -t "slowly rendered"
                                                           # old content.js: fails with “UNCERTAIN: The app recorded…”
                                                           # (reproduces the owner's error); with the fix: passes
npx vitest run --config vitest.integration.config.ts tests/integration/extension.test.ts   # 16/16 (15 earlier
                                                           # + the new slow-render test), first attempt
```

**Not verified here**
- The fix against the real ChatGPT on the owner's PC.
- What reloaded the ChatGPT page during the TITLES job.

### Second report: TITLES stopped again with 3.1.1 (extension 3.1.2)

**Reported by the owner** (screenshots):
- Retry worked: the uncertain prompt was superseded and a fresh one (`…:TITLES:a1:s1`) was sent.
- In ChatGPT, both prompts and both complete answers (with “Recommended Title:”) were visible, in two conversations.
- The task stopped again with the same UNCERTAIN message.

So the restarted job did not recognise its own prompt even though ChatGPT had answered it. Two things are **not known**, because this container cannot open the real ChatGPT:
- what restarts the job on the owner's PC;
- what exactly differs on the real page.

3.1.2 makes the recovery tolerant of the likely differences and reports the rest. Each change is tested on the fake page; three of the new tests fail with 3.1.1 with the owner's error.
- **Each turn counted once.** The adapter's selectors are alternatives, but a turn wrapped as `<article data-turn="user">` around `<div data-message-author-role="user">` matches two of them. Every turn then counted twice, and turn indexes could point at the wrong turn. The extension now keeps the innermost match, in page order.
  - Regression test: with nested markup, a follow-up prompt in the same conversation gets its own answer. It passes with 3.1.1 too, so it only guards against regressions.
- **Looser matching, only with evidence.** When the app has recorded that it sent this prompt, two more matches count:
  - the same text ignoring whitespace, quote and dash variants and Unicode compatibility forms;
  - the last user turn starting with the prompt's first 200 such characters, as when a long prompt is shown shortened.

  Without that record only exact matches count, as before. Test: nested markup, a long prompt shown shortened, page reloaded (fails with 3.1.1).
- **Reload into a new chat.** The extension opens the recorded conversation once and recovers the answer. The server now keeps the recorded conversation when a later progress report has none. Test (fails with 3.1.1).
- **Lost connection to the extension's background.** If Chrome restarts the background service worker, the page reconnects instead of silently dropping progress and the finished answer. The record of a finished job is always removed, so it is never resumed.
- **Clearer stop message.** If the prompt is still not found, the message now names what restarted the job (page reload, background restart, or the app offering the job again). It also says what the page showed: path, user turns, answers, lengths and the first difference. Test (fails with 3.1.1).

**Commands run**
```
npx tsc --noEmit                                           # 0 errors
npx vitest run --config vitest.integration.config.ts tests/integration/extension.test.ts -t "<the 4 new tests>"
                                                           # with 3.1.1: 3 failed (UNCERTAIN), the follow-up test passed
                                                           # with 3.1.2: 4 passed
npx vitest run                                             # 37 files, 255 tests
npx vitest run --config vitest.integration.config.ts tests/integration/extension.test.ts   # 20/20, first attempt
npx vitest run --config vitest.integration.config.ts tests/integration/worker-toolchain.test.ts   # 1/1
npm run build                                              # compiled
```

**Not verified here**
- 3.1.2 on the real ChatGPT.
- What restarts the job on the owner's PC; the new stop message will show it if it happens again.
