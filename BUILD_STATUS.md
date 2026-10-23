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

### Third report: “0 user turn(s); 0 answer(s)” — the new ChatGPT layout (extension 3.1.3)

**Reported by the owner.** The detailed stop message from 3.1.2 read: “restarted after: the ChatGPT page reloaded; page /c/6ad13db5-…; 0 user turn(s); 0 answer(s)”. The ChatGPT window showed the prompt and the complete answer on that page, and the owner's sidebar showed Scheduled / Library / Plugins / Explore.

**Cause.** The extension found the composer, Send and Stop buttons, but no messages at all on the owner's page.
- Developer reports from September 2026 describe a new ChatGPT “Chat / Work” layout, rolled out per account. It drops the `data-message-author-role`, `conversation-turn` and `.markdown` markers this adapter relied on.
  - [steipete/oracle#517](https://github.com/steipete/oracle/issues/517)
  - [chetwerikoff/orchestrator-pack#2171](https://github.com/chetwerikoff/orchestrator-pack/issues/2171)
- Instead the turns carry:
  - `data-turn-key` on each turn;
  - `data-content-search-unit-key="…:user"` / `"…:assistant"` on the user and assistant units;
  - `data-user-message-bubble` around the prompt text;
  - `data-markdown-text-style="assistant-message"` around the answer;
  - a composer in `form[data-chatgpt-composer]`.
- These markers come from third-party reports, **not from the owner's page**. This container cannot open the real ChatGPT (HTTP 403, Cloudflare check).

**Changes (3.1.3)**
- **New selectors.** The new layout's markers are added as alternatives: user, assistant, turn, answer text, composer and Send. The old ones stay, and a turn matched by several selectors counts once (innermost match, from 3.1.2).
- **Self-explaining stop message.** If no user turn is found, the message and the Diagnostics snapshot now list:
  - which layout markers the page has (counts);
  - where the prompt's first words sit in the page: tag and data-attribute names of their ancestors, no text.

  A future layout change will then show its new markers directly.
- **Fake ChatGPT `turnMarkup: 'units'`**, rendering that layout. New tests:
  - one prompt gives one complete answer (headings and a table converted, the Copy control's text not included);
  - a reload recovers the answer, sent once;
  - a follow-up in the same conversation gets its own answer.
- **Reproduced.** With the 3.1.2 adapter, the reload test fails with the owner's exact message (“restarted after: the ChatGPT page reloaded; page /c/…; 0 user turn(s)”).

**Commands run**
```
npx vitest run --config vitest.integration.config.ts tests/integration/extension.test.ts -t "Chat/Work layout|really gone"
                                                           # 4 passed (3.1.3)
same reload test with the 3.1.2 adapter                    # failed: UNCERTAIN … 0 user turn(s) (reproduces the report)
npx tsc --noEmit                                           # 0 errors
npx vitest run                                             # 37 files, 255 tests
npx vitest run --config vitest.integration.config.ts tests/integration/extension.test.ts   # 23/23, first attempt
npm run build                                              # compiled
```

**Not verified here**
- 3.1.3 on the owner's real ChatGPT page. The new layout's markers come from third-party reports.
- **Citation chips inside answers** (the owner's screenshot shows a “BUNTE” source chip in a title option): their markup in the new layout is not known. Their text may end up in the saved answer until it is known.
- What reloads the ChatGPT page during a job on the owner's PC. A reload is now recovered from.

### Fourth report: TITLES → FINAL_ARTICLE worked; FAQS failed (extension 3.1.4)

**Reported by the owner** (screenshots), with 3.1.3:
- TITLES, RESEARCH, LONG_ARTICLE (18,494 characters) and FINAL_ARTICLE (8,927 characters) completed.
- FAQS failed after 3 attempts: “Only 0 of 5 FAQs could be parsed.”
- ChatGPT's answer was right: five “QUESTION: … / ANSWER: …” pairs, each pair on two lines.
- The logs show the same 1,015-character answer saved three times, twice “recovered after interruption”.

**Cause 1 — line breaks lost.**
- The extension's HTML → Markdown conversion collapsed all whitespace inside text.
- In the Chat/Work layout, a pair's two lines are most likely one paragraph whose line break is a newline kept by CSS (`white-space: pre-wrap`), not a `<br>`. This is inferred from the screenshot and the failure; the owner's page was not inspected.
- So every pair arrived as “QUESTION: … ANSWER: …” on one line, and the parser needs ANSWER on its own line.

**Cause 2 — retries reused the rejected answer.**
- A rejected answer makes the stage retry under a new attempt number. That attempt was not marked fresh, so the extension found the identical FAQ prompt as the conversation's last turn and “recovered” its answer — the rejected one — instead of asking again.
- Unit test: it fails on the old code (`fresh` false) and passes now.

**Changes**
- **Extension 3.1.4** keeps a text's newlines wherever the page shows them as line breaks (computed `white-space` pre / pre-wrap / pre-line / break-spaces) and collapses other whitespace as before.
  - The fake renders such paragraphs with `softBreaks`.
  - New integration test: five FAQ pairs arrive line by line and all parse. With the 3.1.3 adapter it fails with the pairs on one line, as in the owner's run.
- **FAQ parser** also accepts “QUESTION: … ANSWER: …” on one line, but only with the upper-case labels the prompt asks for (also FRAGE/ANTWORT). Prose such as “the question: …” is never split. Unit test.
- **Fresh retries:** after a REJECTED or SUPERSEDED answer for a stage, every later prompt for that stage is sent fresh; it is never recovered from the page.
- **Tab discarding:** the automation tabs are marked not auto-discardable, so Chrome's memory saver cannot unload a page during a job. What reloaded the page on the owner's PC is still unknown, and this is a precaution, not a proven fix.

**Commands run**
```
npx vitest run tests/unit/content.test.ts tests/unit/engine.test.ts   # new tests failed first (0 FAQs; fresh false), pass now
npx vitest run --config vitest.integration.config.ts tests/integration/extension.test.ts -t "line breaks the page shows"
                                                           # 3.1.3 adapter: failed (pairs on one line); 3.1.4: passed
npx tsc --noEmit                                           # 0 errors
npx vitest run                                             # 37 files, 257 tests
npx vitest run --config vitest.integration.config.ts tests/integration/extension.test.ts   # 24/24, first attempt
npm run build                                              # compiled
```

**Not verified here**
- 3.1.4 on the owner's page.
- The exact CSS of the new layout's answer paragraphs (inferred).
- Stages saved earlier with 3.1.3 may have lost line breaks inside paragraphs. That is harmless for article prose and tables; the saved RESEARCH notes were not checked.

### Fifth report: first live article reached WordPress (draft #7479); slow QUICK_BIO, Rank Math “0”, report download (extension 3.1.5)

**Reported by the owner** (screenshots and console output), with 3.1.4:
- The article went through every stage. WordPress draft #7479 was created and verified as a draft.
- The article stopped at **Needs review** with four reasons:
  - three unsupported family/relationship claims from the research evidence;
  - “Rank Math score 0 is below the target 75 after 0 correction round(s)”.
- **QUICK_BIO took 11.2 min:** “No complete answer within 600s → retry-reconcile”, then the answer was “recovered after interruption” a minute later.
- **EXTERNAL_LINKS took 6.1 min**, also “recovered after interruption”.
- The owner asked how to send the full details of an article.

**Cause 1 — the answer was looked up by position.**
- The extension counted the user turns on the page before sending and then waited for the answer after turn number N.
- Long ChatGPT conversations keep only their last turns in the page. After the long LONG_ARTICLE and FINAL_ARTICLE answers, turn N was not the new prompt, so the answer was never found until the job timed out.
- After the restart, the prompt was found by its text and the answer recovered at once.
- The fake ChatGPT can now keep only the last N turns in the page (`virtualize`). New test: three prompts in one long conversation. The current extension stalled on the second prompt (“Timed out waiting for ChatGPT response”), like the owner's QUICK_BIO.
- **3.1.5** finds the user turn of the prompt it just sent by its text and by a turn key that was not on the page before sending (search-unit key, message id or turn test id), never by position alone.

**Cause 2 — Rank Math's pre-analysis 0 was taken as the score.**
- Rank Math reports 0 (in its data store and its panel) until it has analysed the content. The reader accepted three equal reads of 0 as the score.
- Now 0 means “not analysed yet”. After 3 s of zeros the Rank Math panel is opened, and only a positive score that holds for three reads is a result.
- If Rank Math shows only 0 during the whole check, no score is claimed. The review reason then says so: “Rank Math showed 0 / 100 for the whole check …”.
- The fake WordPress can now simulate this (`rankMathPending`). Two new tests:
  - with the old reader, the delayed-score test fails with score 0, as in the owner's run; with the new reader it gets the real score;
  - a Rank Math that never analyses claims no score and gives the new reason.
- **Not verified on the owner's site:** whether their Rank Math analyses in the automated editor at all. If it never does, the draft will now say “not verified” instead of “0”.

**New — article report.** The article page has a **Report** button. It downloads one JSON file with everything about that article, for support. Strings pass through the diagnostic bundle's redaction. Unit test. The file holds:
- the task and its review reasons, every stage with its prompt and output, and every ChatGPT exchange (prompt, answer, status, recovered);
- the quality reports, SEO reports and the research evidence;
- internal-link decisions, WordPress / Rank Math verification, recovery incidents and the article's logs.

**Not investigated yet.** The three “unsupported family/relationship claim” reasons quote sentences that read like research commentary in the article: “Der geplante Titel … ist durch die Recherche eindeutig gedeckt”, “Diese Quellen reichen aus …”. Where they came from needs the article's report.

**Commands run**
```
npx vitest run --config vitest.integration.config.ts tests/integration/extension.test.ts -t "only the last turns in the page"
                                                           # 3.1.4: timed out on the second prompt; 3.1.5: passed
npx vitest run --config vitest.integration.config.ts tests/integration/wordpress-drafts.test.ts -t "Rank Math still at 0|never analyses"
                                                           # old reader: score 0 (fails); new: real score / no score + reason
npx vitest run tests/unit/article-report.test.ts           # 1 passed
npx tsc --noEmit                                           # 0 errors
npx vitest run                                             # 38 files, 258 tests
npx vitest run --config vitest.integration.config.ts tests/integration/extension.test.ts          # 25/25
npx vitest run --config vitest.integration.config.ts tests/integration/wordpress-drafts.test.ts   # 10/10
npx vitest run --config vitest.integration.config.ts tests/integration/wordpress-session.test.ts  # 6/6
npm run build                                              # compiled
```

### Sixth report: the article report of draft #7479 — research-evidence false alarms, no images, bold links

**What the owner's report file shows** (`article-report-gloria-krass.json`, from the new Report button):
- **Timings:** TITLES 49 s, RESEARCH 3.8 min, LONG_ARTICLE 2.8 min, FINAL_ARTICLE 78 s, FAQS 46 s, HUMANIZE 64 s. QUICK_BIO 11.2 min and EXTERNAL_LINKS 6.1 min were before 3.1.5.
- **Research sentences were not in the article.** The sentences quoted in two of the four review reasons (“Der geplante Titel … ist durch die Recherche eindeutig gedeckt”, “Diese Quellen reichen aus …”) appear **only in the research notes**; neither the body nor the assembled article contains them.
  - The research checker had taken this editorial commentary as family claims.
  - It matched them to an article paragraph that says Gloria Krass is Sascha Hehn's wife.
  - The warning then quoted the research sentence, not the article's.
- **Only 1 of 12 sources was used** (joyn.de); 10 were “off-topic”.
  - 6 were “about a different Gloria Krass”: the agency's own site and contact page, the XING profile, BUNTE and BILD. The “same person” check required one of the four secondary keywords as a whole phrase (“gloria krass alter”, “gloria krass kinder”, “sascha hehn gloria krass”, “gloria krass wikipedia”), and pages almost never contain SEO phrases verbatim.
  - 4 “did not mention Gloria Krass” in the fetched text. One of them, t-online 2015, names only “Gloria”. RTL and GALA may serve consent pages to automated fetches; the app does not get around those.
- **Images: none.** “Photo search unavailable: DNS lookup failed for commons.wikimedia.org”. The owner's PC returned no DNS address for Wikimedia Commons, while the other sites in the same run resolved. This must be checked on the owner's network.
- **Rank Math 0:** the pre-analysis zero fixed in 3.1.5.

**Changes**
- **“Same person” context:** taken from what each secondary keyword adds to the name, without generic SEO words (age, children, Wikipedia, wife, …). “Sascha Hehn Gloria Krass” gives “sascha hehn”; “Gloria Krass Alter” gives nothing.
  - Added the occupations film agent (DE/EN) and entrepreneur (DE/EN).
  - A namesake still never counts.
  - Unit test with the live run's keywords; a namesake page is still refused.
- **Editorial commentary is not a claim:** sentences about the planned title, the article to be written or the sources' adequacy are skipped. Unit test with the live run's sentences.
- **Clearer warning:** an unsupported-claim warning now quotes the **article's** paragraph and then the research note it was matched to.
- **Bold links (owner request; not in the spec):** a new setting, Settings → Content → Bold links, on by default. It wraps the text of every link in the assembled article in `<strong>`: source links, contextual internal links and the read-more line. Links that are already bold are left alone, and running it twice changes nothing. Unit test.

**Commands run**
```
npx vitest run tests/unit/research-claims.test.ts tests/unit/research-ledger.test.ts tests/unit/content.test.ts
                                                           # new tests failed first, all pass now
npx tsc --noEmit                                           # 0 errors
npx vitest run                                             # 38 files, 261 tests
npx vitest run --config vitest.integration.config.ts <each file>   # all 10 files pass. links.test.ts first failed 1/5:
                                                           # it expected link text without <strong>; expectations
                                                           # updated for bold links (on by default), then 5/5
npm run build                                              # compiled
```
Not re-run here: the real-WordPress e2e. Its one link assertion (`<a href="…"`, the start of the tag) still holds with bold links.

**Not verified here**
- The new same-person rule on the real pages: the fetched page texts are not in the report.
- Why commons.wikimedia.org does not resolve on the owner's PC.

**Follow-up (owner question: “images were off, why Wikimedia?”).**
- **Why the photo search ran:** the IMAGES stage runs only when the article's settings have images on. The settings are fixed when the article starts, and this article's settings had images on.
- **Not known from the report:** whether the owner switched off “Missing images → Needs review” rather than “Article images”, or switched images off after this article had started. The report did not include the settings snapshot.
- **Change:** the article report now includes the settings the article ran with (`settingsUsed`) and its form options. Unit test.
- **Image sources, as the spec says:** celebrity articles collect a photo gallery (Wikimedia Commons here) for the site's template; Tigram/general articles generate their images with ChatGPT.

## Owner request: celebrity photos as in the earlier tool (ChatGPT image search gallery; extension 3.2.0)

The owner asked for celebrity images to work as in their earlier tool ([markroger12/automation](https://github.com/markroger12/automation)). I read that tool's `src/worker/pipelines/stages/images.ts`, its `IMAGE_SEARCH_PROMPT` and its extension's `collectGallery`. It worked like this:
- ChatGPT is asked to “search the web for real photos of <name> and show them as an image gallery”.
- The extension opens the gallery, steps through it with “Next” and saves up to 10 large pictures plus the thumbnails.
- Pictures on hosts the extension may not read are reported as links; the app downloads them.
- Small pictures and duplicates are dropped, and the rest go into the featured design and two body images.

**Built the same way here**
- **Setting:** Settings → SEO, links & images → **Celebrity photo source**: ChatGPT image search gallery (default), gallery then Wikimedia Commons, or Commons only. The owner's own uploads always come first.
- **Prompt:** a new editable prompt, **Celebrity — Image search**, with the earlier tool's text. It uses the Quick Bio full name, otherwise the keyword. The prompt count is now 15.
- **Extension 3.2.0:**
  - for a job marked as an image search, after the answer it opens ChatGPT's picture viewer, steps through it, and saves up to 10 large pictures plus the thumbnails it may read (same origin, or ChatGPT's image hosts);
  - every other picture is reported as a link;
  - it adds host permissions for `images.openai.com` and `*.mm.bing.net`, as in the earlier tool.
- **Server:**
  - the completion accepts `imageLinks` (20 at most, http(s) only), stored on the response (migration `chatgpt_response_image_links`, ADD COLUMN);
  - the IMAGES stage downloads the links through the SSRF-safe fetcher (12 MB cap);
  - it skips pictures under 250 px, exact duplicates and near-duplicates, and orders the rest largest first;
  - then the existing photo check (optional), distinct photos per slot, the site template and alt text apply.
- **Images tab:** gallery entries are labelled “ChatGPT image search”.

**Tests**
- **Extension, fake ChatGPT:** the fake now shows a gallery with a viewer for image-search prompts, plus one picture from another site. The extension opens the viewer once, saves the four large pictures (1024×576) and the thumbnails, and reports the other site's picture as a link.
- **Pipeline (scripted ChatGPT):**
  - the image search was asked once, with the person's name;
  - 3 usable photos: two gallery pictures plus the link, downloaded; the 240×135 thumbnail was skipped;
  - FEATURED, BODY1 and BODY2 use distinct photos, and Commons was not asked.
- The existing Commons tests now set the Commons source explicitly.

**Not verified here**
- The real ChatGPT gallery markup: the thumbnails, the viewer (`[role="dialog"]`) and its Next / Close buttons. The selectors follow the earlier tool's extension, which worked against the real ChatGPT of its time.
- Whether the real gallery's pictures are readable by the extension or arrive as links.

**Commands run**
```
bash scripts/dev-create-migration.sh chatgpt_response_image_links   # ALTER TABLE ChatGPTResponse ADD COLUMN imageLinks
npx tsc --noEmit                                           # 0 errors
npx vitest run                                             # 38 files, 261 tests. 4 expectations changed with the
                                                           # feature and were updated:
                                                           # - the Single Article e2e lists one more prompt (IMAGES
                                                           #   photo search); the German-language-line check now
                                                           #   applies to text prompts only (the search is an image
                                                           #   prompt, as in the earlier tool);
                                                           # - the allowed host permissions now include the two
                                                           #   gallery hosts;
                                                           # - the prompt seed counts 15.
npx vitest run --config vitest.integration.config.ts <each file>   # all 10 files pass (extension 26/26, images 8/8)
npm run build                                              # compiled
```

## Owner report: a scrollbar on the Image Template Designer canvas

The owner's screenshot showed a vertical scrollbar beside the canvas while a full-height layer was selected.

**Cause**
- The selection handles are 12 px squares centred on the layer's edge, so they stick out 6 px.
- When the selected layer touches the bottom or right edge of the canvas, the handles overflowed the frame (`overflow: auto`) and Chrome showed a scrollbar.
- Separately, “Fit” sized the canvas by width only, so on a wide but short window the canvas could be taller than the frame (75vh).

**Fix** (`app/(dashboard)/image-templates/designer.tsx`)
- The frame has 8 px of padding around the canvas, so edge handles stay inside it.
- “Fit” now fits both width and height, also on a window resize, and centres the canvas.
- In “Fit” the frame never scrolls. Zoomed in, it scrolls as before.

**Reproduced first, in a real browser (Playwright Chromium against `next dev`)**
- The check ran against a migrated scratch copy of the local database; `data/` was not touched.
- At 1280×900, 1366×768, 1600×700 and 1920×1080 it selects each layer of the default template and measures the frame.
- Before the fix, selecting the photo or the bottom band (both touch an edge) gave `scrollHeight 332 > clientHeight 326` and a scrollbar: 8 failures.
- After the fix, the same check plus a 1920×650 window passes:
  - no overflow for any selection, and the whole canvas is inside the frame;
  - dragging a layer 50 px moves it 51 px, so pointer mapping is unchanged;
  - zoomed in, the frame still scrolls.
- The check was a script in the session scratchpad. No designer UI test exists in the repository, so none was added.

**Commands run**
```
DATABASE_URL=file:<scratch copy> npx prisma migrate deploy   # scratch copy only
DATABASE_URL=file:<scratch copy> npx next dev -p 3123         # + Playwright check: FAIL 8 before, PASS after
npx tsc --noEmit                                             # 0 errors
npx vitest run                                               # 38 files, 261 tests pass
npm run build                                                # compiled
```

## Owner report: a Polotno design imported wrongly

The owner imported their Polotno Studio design: a white page, a black and blue divider bar in the middle, blue right triangles in the top-left and bottom-right corners, and their “Teche Flux” logo embedded as a picture. The designer showed it wrongly:
- a dark page instead of the white one;
- squares instead of triangles;
- the bottom-right triangles missing;
- the logo turned into “Photo 1”.

**Causes** (`src/lib/image-template.ts`)
- **Background:** named colours such as `white` were refused, so the page fell back to the dark default.
- **Rotation:** Polotno rotates an element around its top-left corner (confirmed in Polotno's own HTML/SVG export: `transform-origin: top left`). Layers here rotate around their centre, so rotated elements landed elsewhere. The triangle rotated 180° about (1920, 1080) ended up off the canvas.
- **Figures:** every `figure` became a rectangle, whatever its `subType`, including circles.
- **Pictures:** every image became a photo slot, including a picture embedded in the file (the logo).
- **Polotno SVG elements:** they carry their SVG as a `data:` URL in `src`. The importer only read an inline `svg` string, so these were never imported.
- **SVG sanitizer:** it wrote names in lower case (`viewbox`, `lineargradient`, `clippath`). SVG is case-sensitive, so browsers and librsvg ignored them: viewBox scaling and gradients were lost on every SVG layer.

**Fix**
- **Colours:** common named colours are mapped to hex, and a page without a colour is white.
- **Rotation:** each element is moved so that, rotating around its centre, it lands exactly where Polotno shows it.
- **Groups:** groups are flattened.
- **Figures:**
  - rect and circle keep their type;
  - triangle, right triangle, diamond, pentagon, hexagon, star and cross become an SVG path, using Polotno's own geometry for the right triangle (`M 0 0 L w 0 L 0 h Z`), which stretches with the layer;
  - other figures are drawn as rectangles, with a note.
- **Embedded pictures:** pictures embedded as `data:` URLs (png, jpeg, webp, gif), including a `data:` page background, stay part of the design.
  - The designer decodes them (not fetched, because the CSP refuses `data:` fetches), applies Polotno's crop if any, and stores them in the site's template library through the existing upload route, which checks them with sharp.
  - They become fixed photos.
  - An image named like “photo” stays a photo slot. Image links are still never fetched and become photo slots.
- **Photo slots:** a design with no photo place gets photo slots behind it.
  - A full-height narrow bar near the centre is read as a divider, giving two slots, one on each side of it.
  - Otherwise one slot covers the canvas.
  - A note says so, and the slots can be moved or deleted.
- **SVG elements:** Polotno SVG `data:` URLs are decoded, `colorsReplace` is applied, and the result is sanitized.
- **SVG sanitizer:**
  - writes canonical names (`viewBox`, `linearGradient`, `clipPath`, …);
  - allows `preserveAspectRatio`;
  - adds the SVG namespace (an `<img>` needs it).
- **SVG drawing:** an SVG with `preserveAspectRatio="none"` stretches with its layer in the renderer and the designer.

**Tests**
- `tests/unit/images.test.ts`:
  - a new test imports the owner's design, with the same coordinates and a 1×1 logo;
  - a new test covers a Polotno SVG `data:` URL and the sanitizer's casing;
  - the existing import test's expectation for a rotated image now uses the top-left pivot.
- On the old importer, all three fail; on the new one, they pass.
- **The owner's real file** (338 KB) went through the importer and the production renderer, giving: a white page, the divider with black edges, both corner triangle pairs, the logo bottom-left, and photos left and right.
- **In Chromium** against `next dev`, on a migrated scratch copy of the database, the designer imported the real file:
  - 9 layers; the logo was stored and shown from `/api/media/…`;
  - the notes were shown;
  - no console errors.

**Not verified:** Polotno's other figures (speech bubble, arrows, cloud, blobs) are drawn as rectangles. Polotno text styling beyond size, weight, colour and alignment is not imported. This file has no text.

**Commands run**
```
npx tsc --noEmit                                                        # 0 errors
npx vitest run                                                          # 38 files, 263 tests pass
npx vitest run --config vitest.integration.config.ts tests/integration/images.test.ts   # 8/8
npm run build                                                           # compiled
```

## Owner report: scrollbars on the article tabs

The tab bar on an article page (Overview … Conversation, 14 tabs) showed a vertical and a horizontal scrollbar.

**Cause** (`src/components/client.tsx`, the shared `Tabs`)
- The bar was a horizontal scroll box (`overflow-x: auto`), which also makes `overflow-y` auto.
- The active tab's underline sits 1 px below the bar (`-mb-px`), so the bar always overflowed by 1 px vertically and showed a vertical scrollbar.
- On narrower windows the 14 tabs did not fit either, so a horizontal scrollbar appeared too.

**Fix:** the tabs wrap onto a second row instead of scrolling. Nothing in the bar scrolls any more.

**Reproduced first** (Playwright Chromium against `next dev`, a migrated scratch copy of the database with one test article)
- Before the fix, at 1600, 1366, 1024 and 390 px wide, the bar was a scroll box with `scrollHeight 38 > clientHeight 37`, and below 1600 px the last tabs were cut off: 4 failures.
- After the fix there is no scroll box at any of these widths and every tab is visible (two rows at 1366 and 1024 px, four at 390 px).

**Commands run**
```
npx tsc --noEmit         # 0 errors
npx vitest run           # 38 files, 263 tests pass
npm run build            # compiled
```

## Owner requests: humanizer in the article's chat; internal link to the previous article

**1. The humanizer opened a new ChatGPT chat for every batch.** The owner wants it to use the chat the article was written in.
- **HUMANIZE stage** (`src/worker/pipelines/humanize.ts`): the batches now go to the article's conversation, one after another. The next batch is sent only after the previous one is answered, because a chat answers one prompt at a time. Before, every batch opened its own new chat, all at once.
- **Humanizer page, source “article”** (`src/lib/humanizer/runs.ts`, `createRunChatGPTRequest`): a run continues in that article's chat, one batch at a time. If that conversation is lost, the remaining batches fall back to new chats. Pasted text still opens new chats.
- **Bug found on the way** (`src/lib/chatgpt/jobs.ts`, `src/worker/pipeline/context.ts`):
  - Every answer saved its conversation as the article's conversation, including the image search's own new chat (IMAGES runs before HUMANIZE), the photo check and image generation. Later prompts and stage regenerations would therefore have gone to the picture chat.
  - A stage's own new chat is now marked `sideChat`. It never replaces the article's conversation, and losing it does not clear the article's conversation either.
  - A conversation switch after a lost chat still moves the article to the new chat.

**2. The last-line internal link did not point to the previous article.**
- The report (`article-report-sascha-hehn-kinder.json`) shows the line “Das könnte Ihnen gefallen:” linked the most related published post (“Sebastian Ströbel Kinder”).
- The owner's earlier tool (`src/worker/pipelines/stages/internal-link.ts` in `markroger12/automation`) always linked the previous article it wrote for the same website.
- **New setting** (Settings → SEO, links & images): **Internal link line target**, with two options:
  - *Previous article of this website* (default, as in the earlier tool);
  - *Most related published post* (the previous behaviour).
- **Which article is “previous”:** the previous keyword of the same workflow, otherwise the latest earlier article of the same website (not failed or cancelled).
- **Which address is linked:**
  - its published post from the internal-link index, checked as reachable;
  - else, if it is a draft, its planned `/<slug>/` address. This is predicted only when the site's indexed posts use plain `/<slug>/` addresses (promizeiten.de does). The Links tab says the link works once that article is published.
  - If nothing fits, the line falls back to the most related post, with a note.
- Contextual links are unchanged. In this report, the related posts had no natural phrase in the body, so none were placed.

**Tests** (each fails on the old code and passes on the new)
- `tests/unit/humanize-stage.test.ts`: the HUMANIZE batches go to the article's conversation, never two at once. A Humanizer page run on an article does the same.
- `tests/integration/images.test.ts`, ChatGPT image search: the gallery prompt opens its own chat, and every later prompt, including HUMANIZE, stays in the article's chat. The task keeps the article's conversation.
- `tests/integration/links.test.ts`, on fake WordPress: the second article's line links the first article (published) instead of the closely related post. With *Most related*, it links the related post.
- `tests/unit/links.test.ts`: the previous article's post is found by its id or title; a draft gets its planned `/<slug>/` address only on `/<slug>/` sites.
- Test helper: `makeDriver` can report a separate conversation per chat and observe each claimed prompt.

**Not verified here:** live ChatGPT with the batches in the article's chat. The test checks one prompt at a time per chat, but not how the real page behaves with a long conversation.

**Commands run**
```
npx tsc --noEmit                                                     # 0 errors
npx vitest run                                                       # 38 files, 267 tests pass
npx vitest run --config vitest.integration.config.ts <each file>     # all 10 files pass (content-refresh 5,
                                                                     # extension 26, images 8, links 6, migration 1,
                                                                     # wordpress-drafts 10, wordpress-session 6,
                                                                     # worker-toolchain 1, workflow-publish 6)
npm run build                                                        # compiled
```

## Owner request: Automation Chrome opens when an article is queued and closes when the queue is done

Before, the ChatGPT Chrome (Automation Chrome, profile `data/chatgpt-chrome`) opened only from the “Open Automation Chrome” button.

**New worker loop** (`src/worker/chrome-autostart.ts`, every 10 s; two switches in Settings → Browser, both on by default)
- **Open:** Chrome opens when an article is queued or a ChatGPT prompt waits, the extension is not connected, and Automation Chrome is not running.
  - It uses the same launch as the button.
  - It tries at most once every 3 minutes, so a Chrome that cannot start does not open window after window.
  - A Chrome that is running, or locked by another host, is left alone.
- **Close:** once nothing is left for 2 minutes, the Chrome the worker opened is closed. “Nothing left” means no queued or running article, no Humanizer run, and no waiting or active ChatGPT prompt. A new article during those 2 minutes keeps it open.
  - **How it closes** (`closeAutomationChrome`): a normal close request, never a forced kill, because a forced kill can lose the ChatGPT sign-in that Chrome has not written to disk yet. On Windows this is `taskkill /PID <pid>` without `/F`; elsewhere it is SIGTERM.
  - **Only that Chrome:** the PID is checked to still be that Chrome before closing (`tasklist` image name on Windows; on Linux and macOS, the command line contains the profile folder), so a reused PID is never touched.
  - **Owner's Chrome is never closed:** a Chrome the owner opened (button or by hand) is not closed.
  - **State:** the PID of the Chrome the worker opened is kept in `data/chatgpt-chrome-auto.json`, so a worker restart still closes it. If the owner closes it while work remains, the worker forgets it and reopens it after the cooldown.

**Tests:** `tests/unit/chrome-autostart.test.ts`, 6 tests:
- open, then close after 2 idle minutes;
- a new article keeps it open;
- the owner's Chrome is never closed, and one the owner closed is forgotten;
- the switches, a connected extension and a failing launch;
- the real queue counts.
- On Linux, a real child process stands in for Chrome: only the process carrying the profile folder receives SIGTERM, and another process is left alone.

**Not verified here:** the Windows path (`taskkill` without `/F` closing Chrome's windows normally) and a real Chrome on the owner's PC.

**Commands run**
```
npx tsc --noEmit                                                       # 0 errors
npx vitest run                                                         # 39 files, 273 tests pass
npx vitest run --config vitest.integration.config.ts tests/integration/worker-toolchain.test.ts tests/integration/extension.test.ts   # 27/27
npm run build                                                          # compiled
```

## Owner report: Resume did nothing on a task paused for a ChatGPT usage limit

The owner's screenshot showed QUICK_BIO paused with “ChatGPT usage limit / rate limit — waiting until 6:15:39 AM”. Pressing Resume changed nothing.

**Cause**
- The extension reported ChatGPT's usage-limit notice (`USAGE_LIMIT`), so the app set the account-wide wait (`chatgpt.rate`, `backoffUntil`) and paused the task.
- Resume woke the article and its prompt, but every claim of a ChatGPT job is refused while that wait lasts. Nothing could happen until 6:15.

**Fix**
- **Resume means “try now”:** Resume on a task paused for a usage limit ends the wait (`clearBackoff`), puts the task back in the queue (“Resumed by you: trying ChatGPT again now.”) and logs that the wait was skipped. The prompt is claimed at once.
- **Next wait is longer:** the backoff step is kept. If ChatGPT is still limited, the extension reports it again and the next wait is longer, not shorter.
- **The task's hint now says:** “Resumes automatically after HH:MM, or press Resume to try ChatGPT now.”
- **Without Resume** the task still resumes by itself when the window passes, as before.

**Test:** `tests/unit/resume-usage-limit.test.ts`.
- After a `USAGE_LIMIT`, claims are refused.
- After Resume, the wait is gone and the same prompt is claimed.
- On the old code it fails: the wait was still set after Resume.

**Not verified here:** what ChatGPT showed on the owner's page. The notice text is stored with the failed prompt, and the article report shows it.

**Commands run**
```
npx tsc --noEmit                    # 0 errors
npx vitest run                      # 40 files, 274 tests pass
npx vitest run --config vitest.integration.config.ts tests/integration/{extension,workflow-publish,wordpress-drafts}.test.ts   # 26, 6, 10 pass
npm run build                       # compiled
```

## Owner report: external links are generated but never placed in the article

The owner's screenshot shows the EXTERNAL_LINKS answer.
- ChatGPT (with browsing) now returns every address as a link.
- The extension turns links into markdown, so each line reads `LINK: NOS | [https://nos.nl/…](https://nos.nl/…?utm_source=chatgpt.com)`.
- Sometimes the address is on the line after `LINK: Der Guardian |`.

**Cause** (`parseLinkCandidates`, `src/lib/links/verify.ts`)
- The parser accepted only `LINK: phrase | <plain URL>` at the end of the line, so every markdown line, and every line whose address was on the next line, was dropped.
- With nothing accepted from news or other sites, the “Wikipedia ≤ half” rule then left no link at all.

**Fix**
- **Address forms:** the parser reads a markdown link's target (also with `(…)` inside, as in Wikipedia's `X_(Band)`), `<url>` and plain URLs.
- **Next line:** it takes the address from the next line(s) when the `LINK:` line has none.
- **Clean addresses:** tracking parameters (`utm_*`, e.g. `utm_source=chatgpt.com`) are removed (`stripTracking`, new pure module `src/lib/links/url.ts`), so the article links the clean address.
- **Trailing `)`:** it is kept only when it closes a `(` in the URL.
- **Research notes:** the same cleaning applies to cited URLs in research notes (claims, ledger, service). A markdown link there names the same source twice, and it is now one citation.

**Tests**
- `tests/unit/links.test.ts`: the owner's answer lines (Guardian on the next line, NOS, BBC Sport), a Wikipedia URL with `(Band)` and two utm parameters, a utm parameter after another parameter, and an unbalanced `)`. The old parser read 2 of 6 links, with the tracking left on one.
- `tests/integration/links.test.ts`: the IMDb candidate now arrives as a markdown link with `utm_source=chatgpt.com`, on the next line. On the old parser, no external link was placed (accepted `[]`). Now it is placed with the clean address and no `utm_source` anywhere in the article.

**Commands run**
```
npx tsc --noEmit                    # 0 errors
npx vitest run                      # 40 files, 275 tests pass
npx vitest run --config vitest.integration.config.ts tests/integration/{links,content-refresh,images}.test.ts   # 6, 5, 8 pass
npm run build                       # compiled
```

## Owner requests: dropdowns and date fields in the theme; “Approve selected” on the queue

**Dropdowns** (“All writers” etc.; the owner asked for every dropdown)
- **Before:** the open list showed white text on a light-blue highlight in dark mode, which was hard to read.
- **Fix:** `app/globals.css` styles every `<select>` in the app, with nothing changed per page.
  - Options take the theme's colours; the chosen one is indigo with white text.
  - **Chrome 135+** (the owner's browser) gets the customizable select (`appearance: base-select`): the whole list is drawn in the theme, with a hover row, a rotating arrow and one-line labels (a long label is cut, as natively).
  - Other browsers keep the native list, with the option colours.

**Date fields:** the browser's calendar ignores the dark theme and cannot be styled.
- **New component** `src/components/date-picker.tsx`, the app's own calendar:
  - month navigation, today marked, Clear and Today;
  - keyboard: arrows, PageUp/PageDown, Enter, Escape;
  - From/To limits; the same `YYYY-MM-DD` value in local days.
- **Where it replaces `<input type="date">`:** History From/To, and Search Performance first/last day.

**Approve selected** (queue/history bulk bar), `approveWaiting` in `src/lib/tasks/actions.ts`, bulk action `approve`.
- Each selected task gets the approval it is waiting for, as on its article page:
  - **Title approval:** the chosen or recommended title.
  - **Article approval:** the article is approved.
  - **Needs review:** approved despite its review reasons (`overrideQuality`, with the owner's reason; the dialog asks for it only when such a task is selected). A same-site duplicate keyword is allowed instead.
- Other tasks are skipped, with the reason.
- Every approval is audited.

**Also:** “Worker offline” on the queue page failed colour contrast (rose-600). It now uses rose-700, or rose-400 in dark mode. The audit found it here because the worker was not running.

**Checked**
- **Chromium 141 against `next dev`** (scratch copy of the database), dark and light:
  - the writer dropdown opens in the theme and choosing works;
  - form dropdowns on Single Article and Settings stay one line high, and open above when there is no room below;
  - the date picker: keyboard choice, Clear, Escape, no console errors;
  - the Approve dialog.
- `tests/unit/bulk-approve.test.ts`: title, article, review (refused without a reason), duplicate, and skipping a running task; 4 audit entries.
- `npm run audit:a11y` (bundled Chromium): **58/58, no violations**. The first run found the rose-600 contrast, now fixed.

**Commands run**
```
npx tsc --noEmit                                              # 0 errors
npx vitest run                                                # 41 files, 276 tests pass
BROWSER_CHANNEL=chromium npx tsx scripts/a11y-audit.ts http://127.0.0.1:3123   # 58 ok, no serious/critical
npm run build                                                 # compiled
```

## Owner report: RANKMATH stops with “Could not place the complete prompt in the composer as text”, and Retry does not reopen Chrome

**1. The SEO-correction prompt was not placed in ChatGPT's composer** (RANKMATH, 5 times; once “composer did not become ready”).
- **What differs from prompts that work:** during RANKMATH the app sends SEO_CORRECTION with the whole article as markdown. EXTERNAL_LINKS sends the same article and works, but the RANKMATH copy is the finished article, with `[**anchor**](https://…)` links (bold links) and `**bold**`. The issue list was also written as `- ` lines.
- **Suspected cause (not verified on the real page):** a rich-text composer that turns typed markdown links into links. In the fake ChatGPT page (new option `markdownLinks`), such a composer reproduces exactly the owner's error. The humanizer's `{L1}…{/L1}` / `{b}…{/b}` marks are typed exactly in the real composer (HUMANIZE ran in the owner's live run).
- **Fix** (`src/lib/seo/correction.ts`, `src/worker/pipelines/wordpress.ts`):
  - The SEO-correction prompt carries links and bold/italic as those marks (`markRichText`), with a note to keep them, and numbered issues (`1.`) as the humanizer uses.
  - Each link keeps its original tag (URL, attributes, inner bold) and gets it back after the answer (`restoreRichText`).
  - A link ChatGPT drops stays dropped, so the existing correction guard rejects the correction and keeps the article.
  - Braces in the text become look-alikes and cannot forge a mark.
- **Extension 3.2.1:** when a prompt cannot be placed, the stop now says how many characters the composer showed, and where and what the first difference was (or that ChatGPT turned the prompt into a “Pasted text” attachment). The next real occurrence shows the actual cause.

**2. Retry did not bring Chrome back**
- On Retry the task is queued, and the auto-open does not open Chrome while the extension still counts as connected or while Automation Chrome is running.
  - **Connected:** this held for up to 2 minutes after the window closed. It is now 75 s; the extension polls every 30 s.
  - **Running:** Chrome may keep running after its window closes, and then no window comes back.
- **New:** a due ChatGPT prompt that nobody claims for 90 s (no other prompt running, no usage-limit wait) is “stuck”. The worker then opens the Automation Chrome profile again, which opens a ChatGPT window in the running Chrome. This happens once per stuck prompt, at most every 3 minutes.
- **Logs:** when Chrome is not opened for waiting work, Logs say why once: switched off, already running, or locked by another computer.

**Tests**
- `tests/unit/wordpress.test.ts`:
  - the marked prompt has no markdown link, URL or `**`, and the links, bold, italic and braces come back exactly;
  - an answer that drops a link is rejected by the guard.
- `tests/integration/extension.test.ts`:
  - with the fake rich-text composer, the old markdown-link prompt stops with the exact owner message plus the new detail (`… first difference at character N: expected "…[**NOS…"`) and is never sent;
  - the same text with marks is typed exactly and answered.
- `tests/integration/wordpress-drafts.test.ts`: SEO-correction prompts have no markdown links, URLs or `**`, use numbered issues, and carry the marks note. The fake WordPress article has no links, so this run passes on the old code too; the round trip itself is covered by the unit test.
- `tests/unit/chrome-autostart.test.ts`:
  - a stuck prompt with Chrome running opens a window once per prompt;
  - a usage-limit wait or a running prompt is not “stuck”;
  - the reason is logged once.

**Not verified here:** the real ChatGPT composer's behaviour with markdown links, and Windows Chrome opening a window when the profile is already running.

**Commands run**
```
npx tsc --noEmit                                                     # 0 errors
npx vitest run                                                       # 41 files, 280 tests pass
npx vitest run --config vitest.integration.config.ts <each file>     # all 10 pass: content-refresh 5, extension 27,
                                                                     # images 8, links 6, migration 1, wordpress-drafts 10,
                                                                     # wordpress-session 6, worker-toolchain 1, workflow-publish 6
                                                                     # (the first combined run hit the 10-minute command limit
                                                                     # before workflow-publish; it was run again on its own)
npm run build                                                        # compiled
```

## Owner request: live Search Console data, and indexing requested and proven after a workflow publish

The owner created a Google Cloud service account (no billing needed). Previously the app showed only exports the owner imported, so this changes the earlier rule “nothing is fetched from Google” at the owner's request. Only Google's official API is used, with the owner's own service account, and nothing is estimated.

**Connection** (`src/lib/gsc/client.ts`, Search Performance page → “Live data”)
- **Key file:** the owner uploads the service-account JSON key. It is stored in `data/credentials/gsc-service-account.json` (mode 600), and its private key is never returned, logged or reported. The redaction now also removes PEM private keys and `private_key` fields.
- **Login:** a service-account JWT is signed with Node's crypto (RS256, no new dependency) and exchanged for an access token (scope `webmasters`). One token request at a time: the sync's parallel queries share it; this was found in the test, where 6 tokens were requested at first.
- **Test connection** lists the properties the account can see and shows its permission for the website's property.
- **Errors say what to do:** 401/403 → “add <email> in Search Console → Users and permissions with Full”; 429 → quota, tried later; a key Google refuses → upload a new key.

**Live sync** (`src/lib/gsc/sync.ts`; worker loop every 30 s, one website per tick; a sync is due every 2 h, or 30 min after a failure; also “Sync now”)
- **One snapshot per sync** (source `GSC_API`). It replaces the previous live snapshot; imported exports are kept.
  - **DATE:** 16 months (`dataState: all`, fresh days included and marked by Google's `firstIncompleteDate`).
  - **PAGE:** the last 28 days with the 28 days before as the comparison, paged by 25,000 rows, up to 50,000.
  - **QUERY:** the same periods, top 5,000.
  - **HOUR:** the last 3 days (`HOURLY_ALL`); Google says the latest hours are incomplete.
- **The existing analysis works on it:** trends, declining pages, published articles without impressions, and Content Refresh evidence. The 1,000-row export cap no longer applies to live data.
- **Page:** a live badge in the text, the last sync (or its error), and a “Last hours (live)” table.

**Indexing after a workflow publish** (`indexingTick`) — *replaced on 2026-10-22: the request is now made in Search Console's URL Inspection by Automation Chrome, as the owner does it; see “Request indexing as the owner does it” below. The proof part is unchanged.*
- **Sitemap resubmit:** 35 s after a verified publish, if the workflow has “Request indexing after publishing” on, the sitemaps Search Console knows for the property are resubmitted (`sitemaps.submit`). If there are none, `<site>/sitemap_index.xml` is submitted.
  - The keyword becomes INDEXING_REQUESTED, with the note “a request is not proof of indexing”.
  - Google's “Request indexing” button has no API.
  - The Indexing API is not used: Google allows it only for job-posting and livestream pages.
- **Proof:** Google's URL Inspection API is asked 1 h, 6 h and 24 h after publishing, then daily for 14 days. This happens for every published workflow post, also without the switch.
  - INDEXED only when Google's verdict is PASS (“URL is on Google”), with its coverage state and last crawl time.
  - After 14 days the checks stop with “Not indexed 14 days after publishing (Google: …)”.
  - A quota or permission error retries in an hour without advancing the schedule.
- **Search Performance indexing counts:** “Indexed (Google says)” is now kept apart from “Indexed (confirmed by you)”.
- **Migration** `workflow_keyword_index_checks`: `ALTER TABLE WorkflowKeyword ADD COLUMN indexCheckAt / indexChecks`. Prisma proposed a table rebuild; it was replaced by two ADD COLUMN statements, and `prisma migrate diff` shows no drift.

**Tests:** `tests/unit/search-console-live.test.ts` runs against a fake Google (`tests/fixtures/fake-google.ts`): its token endpoint verifies the JWT signature with the test key's public half, and it serves the Search Console API.
- **Key:** wrong files are refused, and the private key is never returned; a key Google refuses gives a clear message.
- **Sync:**
  - 481 days, 30,000 pages over two API pages (`startRow` 0 and 25,000), queries with previous values, and 3 hours;
  - one token for the whole sync;
  - the analysis reads it (declining page 40 → 3 clicks, hourly rows, trends);
  - a new sync replaces the old live data and keeps the export;
  - a 403 is stored with the “add … with Full” message.
- **Indexing:**
  - nothing at 20 s; a sitemap resubmit at 36 s;
  - 1 h not indexed, so the next check is at 6 h; at 6 h INDEXED with Google's evidence;
  - without the switch, no request but still checked; after all 16 checks the checks stop;
  - nothing happens without a key.
- **Updated test:** the existing Search Performance unit test now has `indexedByGoogle: 0`. The owner's own confirmation is not Google's answer.
- **Chromium against `next dev`:** the “Live data” card before and after uploading a key; the key is stored on disk; no console errors.

**Not verified here:** the real Google API with the owner's property; a real sitemap resubmit; URL Inspection answers for promizeiten.de.

**Commands run**
```
bash scripts/dev-create-migration.sh workflow_keyword_index_checks   # then replaced by ADD COLUMN; migrate diff: empty
npx tsc --noEmit                    # 0 errors
npx vitest run                      # 42 files, 287 tests pass
npx vitest run --config vitest.integration.config.ts tests/integration/workflow-publish.test.ts tests/integration/content-refresh.test.ts   # 11 pass
npm run build                       # compiled
```

## Owner reports: EXTERNAL_LINKS stopped, review reasons that were not problems, images, and a fresh laptop

Reports: Antivirus FreeDoor2.4.6.8 and latest tech info beaconsoft (Tigram, FAILED at EXTERNAL_LINKS), Mary Joan Schutz and Dixie Brubaker (celebrity, NEEDS_REVIEW with 9 and 14 reasons), the image template screenshot, and a second laptop where `npm run start:all` failed.

**EXTERNAL_LINKS: “Could not place the complete prompt … found "]( https://…"”**
- **Cause:** ChatGPT's composer puts a space between `](` and an address typed after it. The extension compared the text exactly and stopped after 3 tries. The article's links came from the writer's own ChatGPT citations, with `?utm_source=chatgpt.com`.
- **Reproduced:** the fake ChatGPT got a `linkParenSpace` mode that does the same. The new extension test timed out on the old adapter and passes now (2/2, together with the earlier markdown-links test).
- **Extension 3.2.2:** a difference made only of whitespace counts as placed. Markdown reads `]( https://…` the same way.
- **Server side:**
  - the EXTERNAL_LINKS prompt carries the article's links as their text only;
  - `utm_` parameters are removed from the links an article is written with, and from bodies saved earlier when EXTERNAL_LINKS runs again.
  - This works without reloading the extension too.
- **Tigram images:** both Tigram tasks stopped at EXTERNAL_LINKS, before IMAGES, so no image was ever made. With the stop fixed they reach IMAGES. No report of a Tigram IMAGES failure itself was available; the generated-image flow is covered by the existing images integration test only (fake ChatGPT).

**Review reasons that were not real problems** (`tests/unit/owner-review-reasons.test.ts`, research-ledger test; all 4 new tests fail on the old code)
- **Research Evidence:**
  - headings and outline titles in the research notes (“Meet Dinesh D’Souza’s Ex-Wife”, “… — Cover the wedding …”), bracketed source titles, court case citations (“In re Marriage of …”) and “Recommended wording:” lines are no longer claims;
  - an article heading is never matched as stating a claim;
  - one review reason per article paragraph (Dixie's paragraph 1 had three), and one per kind of contradiction (two birth-date reasons became one);
  - “some smaller … websites identify”, “less authoritative”, “pending verification” mark a note as uncertain.
  - Unsupported claims that the article does state are still review reasons; nothing is marked verified without a source.
- **Rank Math field check:** Rank Math showed `D'Souza` for `D’Souza`. Quotes, dashes and ellipses are now compared in one form.
- **Meta description from the intro** ended mid-phrase (“… spent more”). It now ends at a sentence end, else at a clause (with a full stop), else at a word with “…”.
- **“Not publicly confirmed” appears N times** now counts prose only. In Quick Bio rows it is the intended fallback.

**Images** (`tests/integration/images.test.ts` 9/9, new `tests/integration/image-tools.test.ts` 3/3)
- **Your template first:** the featured template takes its photos first, as in markroger12/automation. With two photos the owner's two-photo design was replaced by the single-photo preset; now it gets both, and the body gets what is left. No photo is used twice.
- **Image search:**
  - prompt v2 asks for up to 10 photos and allows archival photos. v1 asked for “at least 10 recent” and ChatGPT answered with text only (Dixie) or said only two existed (Mary Joan). The old default is upgraded by setup unless edited;
  - a text-only answer is asked once more in a new chat, as in the earlier tool.
  - The new test fails on the old code (one search only).
- **Face locations (from the earlier tool):** MediaPipe BlazeFace runs in a headless browser from local files (`src/images/faces.ts`). Photos with a face come first and crops centre on the faces. Locations only, never identities.
  - The files are installed by `npm run tools:install`, and by `start:all` / `dev:all` the first time (MediaPipe tasks-vision 0.10.21 from npm, released 2025-02-06, plus the BlazeFace model). No npm dependency was added.
  - Tested for real here: 1 face in the public-domain portrait fixture (Lincoln, 1864), 0 in a plain picture, in about 1.3 s. In a celebrity run that portrait was ordered first and became the featured photo.
- **Upscayl (from the earlier tool):** `src/images/upscale.ts` runs `upscayl-bin -s 4 -n remacri-4x` from `data/tools/upscayl`. Photos stretched more than 1.5× are enlarged before cropping.
  - Setting “Enlarge small celebrity photos”, now on by default. A missing tool is named on the Images tab.
  - Tested with a FAKE `upscayl-bin` script (same arguments). The real Upscayl needs a GPU and was not run here.

**Fresh install: “The table main.WorkerStatus does not exist”**
- **Cause:** on the second laptop `npm run start:all` ran straight after `npm install`: no `npm run setup` (tables) and no `npm run build`.
- **Fix:** `prestart:all` and `predev:all` run `scripts/preflight.ts` by themselves:
  - the safe setup steps: data folders, `.env` only when missing, migrations with a backup and never a reset, missing settings and prompts, the face detector;
  - for `start:all` also a build, when there is none or the git commit changed since the last build (`postbuild` records it).
- **Worker message:** a database without tables now says to run setup.
- **Verified:** preflight on an empty data folder created every table (WorkerStatus readable) and installed the face detector.

**Not verified here**
- The real ChatGPT composer with extension 3.2.2.
- Real Tigram image generation after EXTERNAL_LINKS.
- The real Upscayl binary on Windows.
- MediaPipe in the owner's Chrome (headless).
- Whether ChatGPT shows a gallery for Dixie Brubaker on the second try.

**Commands run**
```
npx tsc --noEmit                    # 0 errors
npx vitest run                      # 43 files, 293 tests pass (after updating 4 expectations: Upscayl on by default, second photo search)
integration: extension 28/28, images 9/9, image-tools 3/3 (real MediaPipe with BAS_TEST_MEDIAPIPE_DIR; skipped without),
             links 6/6, content-refresh 5/5, migration-upgrade 1/1, worker-toolchain 1/1, wordpress-drafts 10/10
             (one wordpress-drafts test timed out once while running in parallel with the extension file; it passed alone and in the file rerun)
npm run build                       # compiled; postbuild recorded the commit; preflight --build then said "up to date"
npx tsx scripts/preflight.ts        # on an empty data folder: all tables, settings, prompts, face detector
```

## Owner requests (2026-10-21): delete, approved duplicates, review off, images from automation-old

**Delete articles and campaigns** (owner report: queued and completed articles could not be deleted; there was no delete at all)
- `src/lib/tasks/delete.ts`:
  - the article's report (stages, prompts, answers, logs) is written to `data/backups/deleted-articles/<id>-<slug>.json`;
  - its waiting queue jobs are removed; its campaign row becomes CANCELLED; its workflow keyword becomes SKIPPED and its slot is released;
  - the task row is deleted (stages, responses and reports cascade). WordPress is not touched.
- **A running article** (an ACTIVE job) gets `deleteWhenStopped`. It is cancelled and deleted when `markCancelled` runs.
- **Campaign delete:** `deleteCampaign(id, withArticles)`.
- **UI:**
  - queue/history: a row bin icon and “Delete selected”, with a confirmation;
  - article page: Delete;
  - campaign page: Delete, with an “also delete its articles” checkbox.
- **API:**
  - `DELETE /api/tasks/[id]`;
  - bulk action `delete`;
  - `DELETE /api/campaigns/[id]` with body `{ articles }`.

**An approved duplicate keyword continues** (owner report)
- **Cause:**
  - the pre-check's reasons read “Possible duplicate on this website: …”;
  - “Approve selected” and the article page only recognised “Duplicate keyword …”, so approval ran the plain review override;
  - that override reset only the quality gate, so the pre-check held the article again.
- **Fix:** `heldForDuplicate()` recognises both texts, and a FAILED pre-check stage. “Approve despite review reasons” on a duplicate hold also allows the duplicate.

**Review system off by default** (owner decision): `workflow.holdForReview`, default false.
- **Finalize:** a verified draft with review reasons is COMPLETED (“Verified WordPress draft #N. K note(s) on the article page.”).
- **Notes:** the reasons are kept and shown as Notes on the article page.
- **Quality-gate hard stop:** the draft is still saved, and `options.publishBlocked` records the problems. The workflow scheduler never publishes such a draft: its keyword becomes FAILED with the reason.
- **Turned on:** the previous behaviour.
- **Data migration** `2026-10-21-review-reasons-become-notes`: NEEDS_REVIEW tasks with a verified draft (VERIFIED_COMPLETE verified) become COMPLETED. A backup is written first. Tasks without a draft are unchanged.
- **Override migration key list:** the 2026-10-14 override-unpin migration keeps its original key list, so the new key does not change what it recognises.

**Images: the concepts of the owner's earlier tool** (`markroger12/automation-old`, uploaded by the owner; not the GitHub `Automation` repository, which is older)
- **Celebrity** (`images/choose.ts`, `similar.ts`, `faces.ts`, `enhance.ts`, `review.ts`):
  - up to 10 gallery photos;
  - a cropped copy (fingerprint of the area around the main faces, ≤ 6 bits with one face, ≤ 12 with several) counts once;
  - soft = sharpness below 0.4 × the gallery's median, with 3+ photos;
  - ordering: uploads first, then a face before no face, sharp before soft, biggest face first;
  - photo check: watermark last, collage last and never a body image, alt text “Name – description”;
  - Upscayl by the photo's place: stretched > 2× → enlarged 4×; a soft photo is sharpened from a quarter-size input. The tool is found in `data/tools/upscayl` or one folder below; it runs with the tool folder as cwd.
- **Renderer** (`src/images/render.ts`):
  - the earlier tool's face crop: centred across, a little above the middle with room over the heads;
  - a photo much taller than its place is shown whole on a blurred copy of itself.
- **Tigram:**
  - image plan v2 and generation prompt v2 (the earlier tool's texts: the featured picture shows the short title, the body pictures are flat illustrations without text);
  - `featuredImageTitle()`; the earlier tool's default descriptions for missing plan lines;
  - a missing or repeated picture is asked once more in a new chat (identical files are stored once, so a repeat arrives as no picture);
  - the featured picture gets the picture-with-logo design.
- **Logo on every picture:** without a body template, the logo goes in a corner.
- **Not changed:** the earlier tool's own Image Search Prompt is “Search On google and give me any random colors pic high quality 5 to 10 pic simple pic random color.” This app keeps its prompt for photos of the person. The owner can paste the old one in the Prompt Manager.

**Tests** (each new behaviour has a test; the duplicate and review ones fail on the previous code)
- `tests/unit/owner-delete-review.test.ts` (8): review off on the real engine, duplicate approval both ways, finalize notes, data migration, delete of queued/completed/running articles, campaign delete.
- `tests/unit/images.test.ts` (+3): old plan format, featured title, tall photo shown whole.
- `tests/integration/images.test.ts` (+1): title in the featured prompt, a repeat asked again, the logo in the corner of all three pictures.
- `tests/integration/image-tools.test.ts` (+2):
  - soft photo last;
  - photo check ordering, collage never body, alt text;
  - real MediaPipe face test (with `BAS_TEST_MEDIAPIPE_DIR`);
  - fake Upscayl with the earlier tool's arguments.
- **Updated tests:** two Tigram e2e lists (three image prompts now follow the default plan), and image test matchers for the new prompt texts.

**Not verified here:** the real ChatGPT image generation with the v2 prompts; the real Upscayl on Windows; deleting from the owner's real queue.

**Commands run**
```
npx tsc --noEmit                    # 0 errors
npx vitest run                      # 44 files, 304 tests pass
integration: images 10/10, image-tools 5/5 (real MediaPipe with BAS_TEST_MEDIAPIPE_DIR), wordpress-drafts 10/10 (two
             Rank Math tests now expect COMPLETED with notes), links 6/6, workflow-publish 6/6, content-refresh 5/5,
             migration-upgrade 1/1
npx next build                      # compiled
```

## Owner request: bulk category in Bulk Campaigns
- **New campaign → Preview:** when rows are selected, the bar has a **Category…** dropdown. It lists the categories of the website the selected rows are on, and sets that category on every selected row (the same preview correction as the per-row dropdown). If the rows are on several websites, the bar says to select one website at a time.
- **Campaign page:** the same dropdown for rows that are not queued yet. It uses the existing `category` row action, and `getCampaign` now returns the categories of the rows' websites.
- **Verified in Chromium against `next dev` (scratch database):**
  - preview: three celebrity rows were all set to “Biography”;
  - campaign page: a NEEDS_CATEGORY row became READY with its category, and “1 row(s) updated.” was shown;
  - no console errors on either page.
- **Commands:** `npx tsc --noEmit` (0 errors); `npx vitest run` (44 files, 304 tests pass).

## Owner report: Tigram pictures not made (pulsamento); Humanizer per website

The report showed three separate problems.

**1. The featured picture was drawn but never collected.**
- ChatGPT showed the picture, yet the job reported “generating (0 chars so far)” for 600 s and then “No complete answer”.
- Two things in extension 3.2.2 could cause this:
  - the page-wide check `[data-testid*="streaming"]` / `aria-label*="Stop"` stayed true;
  - pictures were only searched by the known address or alt patterns.
- The real page markup was not available. Both were reproduced on the fake page (`imageMarkup: 'unknown'`, `staleStreaming: true`), where the old code timed out.

**2. A recovered job took another article's answer.**
- After the timeout, a recovery attached a later prompt's answer from the same chat (another article's humanizer text, “Cy Kass …”) as the featured picture's answer.
- **Cause:** “the last answer after the prompt” was used.
- Reproduced on the fake page: the old code returned the “Cy Kass” text.

**3. Three pictures were sent at once into three new chats.**
- These ran in background tabs. Two prompts became uncertain (“not visible in this conversation”).

**Fixes**
- **Extension 3.2.3 — answer boundaries:** an answer and its pictures are taken only between the prompt and the next user turn (`inAnswerOf`).
- **Extension 3.2.3 — finding pictures,** as in `automation-old`:
  - any picture in that answer counts when it has loaded at 700×350 or more, as well as the known addresses;
  - drawing is detected by the composer's Stop button or “Creating image”, not by page-wide markers;
  - pictures must stay unchanged for 6 s;
  - a hidden ChatGPT tab is brought to the front while a picture is drawn (new `come-to-front` message).
- **App:** the Tigram pictures are made one after another in the article's chat, as the earlier tool did. Only a second try goes to a new chat.

**Humanizer per website** (owner request)
- **Website form:** a new “Humanizer” option (Inherit / On / Off). The override key already existed but was not in the form.
- **Default off:** the global default is now off.
- **Data migration** `2026-10-21-humanizer-off-by-default`: turns a saved global “on” off once. Websites set to On keep it.

**Tests**
- Extension: 2 new owner-report tests. Both fail on the old adapter/content (with the version string matching) and pass now; the existing image-answer test still passes.
- `owner-delete-review`: +1 test (humanizer default, migration, a website switching it on).
- Humanizer and e2e tests now switch the humanizer on in their setup.

**Not verified here:** the real ChatGPT image page with 3.2.3.

**Commands run**
```
npx tsc --noEmit                    # 0 errors
npx vitest run                      # 44 files, 305 tests pass
integration: extension 30/30, images 10/10, image-tools 5/5, wordpress-drafts 10/10, links 6/6,
             workflow-publish 6/6, content-refresh 5/5, migration-upgrade 1/1
npx next build                      # compiled
```

## Owner report: FINAL_ARTICLE stops with “Chat composer not found”, and Retry stops the same way (malaak compton rock; extension 3.2.4)

**What the report showed**
- FINAL_ARTICLE failed with “Chat composer not found” and later “the composer did not become ready within 60 seconds”.
- Every Retry did run, but stopped at the same step within a minute, so it looked as if Retry did nothing.
- The screenshots show ChatGPT open in the “Work” layout with the usual “Ask ChatGPT” box.

**Likely cause (inferred; the real page markup was not available)**
- The extension refuses text boxes inside canvas or document editors (`[class*="canvas"]` and similar), so it never types into a writing block.
- If the Work layout wraps the whole page in a canvas-styled container, that rule also refuses the real composer, and no composer is found.
- Reproduced on the fake page with a new `workLayout` option (the page inside `<div class="work-canvas-layout bg-token-canvas">`). The committed 3.2.3 adapter timed out there; the prompt was never sent.

**Fix — extension 3.2.4**
- A text box inside the chat's composer form (the form holding the send, stop or voice button) is taken as the composer, even inside a canvas-styled container. A writing block is still never used.
- If none is found, the earlier rule applies, then a visible text box whose placeholder is the chat prompt (“Ask ChatGPT”).
- `[contenteditable="true"][role="textbox"]` was added to the composer selectors.
- When no composer is found, the error now lists the page's text boxes (tag, role, visible or hidden, in the composer form or not, which exclusion refused it, and the first 30 characters of the placeholder). It never includes the text typed in them.
- The app expects extension 3.2.4 (`src/lib/agent/version.ts`).

**Tests**
- New extension test: “the chat composer inside a canvas-classed Work layout is still found (prompt sent once)”. It fails (timeout) on the 3.2.3 adapter and passes now.
- The alternate-DOM, markdown-link, `](` space and missing-DOM-marker tests still pass.

**Not verified here:** the real ChatGPT Work layout. The fix rests on the report and the screenshots. If the error comes back, its new “text boxes on the page” part shows what the page offers.

**Commands run**
```
npx tsc --noEmit                    # 0 errors
npx vitest run                      # 44 files, 305 tests pass
npx vitest run --config vitest.integration.config.ts
                                    # 10 files, 80 pass, 1 skipped (real MediaPipe: MP_SRC not set)
                                    # extension 31/31
```

### Second report: “still the same error” with 3.2.4 (extension 3.2.5)

**What the first report already showed, read again**
- TITLES, RESEARCH and LONG_ARTICLE worked in the same chat. About 20 s after LONG_ARTICLE, FINAL_ARTICLE's first try failed with **“Send button not available”**: the composer was found and the prompt typed, but there was no usable Send button.
- The next tries failed with “Chat composer not found” or “did not become ready”. The composer was there at one moment and gone the next.
- So the ChatGPT page itself had stopped working, whatever the markup.

**Why every Retry failed the same way**
- The extension marks a tab “ready” when its page loads, not when the composer works.
- A retry in the same conversation therefore ran on the same stuck page without loading it again. Each retry failed within a minute, and no retry could ever succeed.
- This was reproduced on the fake page. A new test helper (`__fakeStick`) makes the page stop working after an answer: either the composer is hidden, or a Stop button stays where Send should be. A reload clears it.
- With 3.2.4, the next prompt failed three times with the owner's exact messages (“composer did not become ready within 8 seconds …”, “Send button not available.”). The page was never reloaded.

**Fix — extension 3.2.5**
- **Reload during the job.** When the composer is missing, never becomes ready, or has no usable Send button, the job reloads the page once and runs again on the fresh page. These errors all come before Send, so nothing has been sent. The prompt is typed afresh, and a prompt the job typed is cleared first.
- **If it still fails,** the job stops with “… The ChatGPT page was reloaded once and it still did not work.” and the list of text boxes on the page.
- **Next attempt.** The tab is marked, so the next attempt on it starts from a freshly loaded page, even in the same conversation. The same happens after “Tab could not start the job”.
- **Checkpoints.** A step-only checkpoint (such as the new “reloading”) no longer erases a recorded send time. The send time is the evidence that stops a resend after a reload.
- **Article report.** It now has `chatgptPageSnapshots`: for each failed ChatGPT job, what the extension saw on the page. That covers composer found, Send or Stop visible, generating, page URL, layout markers and the list of text boxes. Page text is never included.

**Tests**
- 3 new extension tests:
  - stuck without a composer: reloaded, sent once;
  - stuck without a Send button: reloaded, sent once;
  - stuck even after the reload: stops with the reason and the text-box list, never sends; the next attempt reloads and succeeds.
- The first two fail on 3.2.4, which retries three times on the stuck page.
- With the background reload switched off, the third test times out on its second part. That proves the next attempt's reload is what makes it work.
- `article-report` unit test: the page snapshot of a failed job is in the report.

**Not verified here**
- The real ChatGPT page. It is not known *why* the owner's page stopped working. A reload is what a person would do, and it is what the fix does.
- If the page fails again right after the reload, the new report's `chatgptPageSnapshots` and the error's text-box list will show what the page offered.

**Commands run**
```
npx tsc --noEmit                    # 0 errors
npx vitest run                      # 44 files, 305 tests pass
npx vitest run --config vitest.integration.config.ts
                                    # 10 files, 83 pass, 1 skipped (real MediaPipe: MP_SRC not set); extension 34/34
stuck-page tests on 3.2.4           # 2 failed: three retries on the stuck page with the owner's messages
stuck-page retry test, background reload switched off   # failed (timed out), as expected
stuck-page, missing-DOM and handshake tests on the final 3.2.5 files   # 5 passed
next build                          # compiled
```

## Owner report: celebrity gallery pictures shown as broken-picture icons (extension 3.2.6)

**Reported by the owner** (screenshots):
- A celebrity image search sometimes answered with a grid of captioned cards (“1. Andre Rock portrait”, “2. Andre with Chris Rock” …). Each card showed only a broken-picture icon.
- Right-click → “Open image in new tab” showed the photo. So the address works, but the ChatGPT page could not show it.
- This happens only for celebrity photos.

**Cause**
- The extension takes gallery pictures from images of at least 60×60 px on the page.
- A picture the page cannot load is drawn as a small icon with its alt text, about 20 px high. So it never counted.
- After waiting 90 s the job reported “ChatGPT showed no picture gallery”, and the article got none of those photos.
- **Reproduced on the fake page** with a new `galleryBroken` option: captioned cards whose pictures the page cannot load, from a host that refuses them (HTTP 403 inside the page). The 3.2.5 extension reported no picture at all.

**Fix — extension 3.2.6**
- **Broken pictures count.** A picture the page failed to load still counts as a gallery picture when it has an address and a caption (alt text). This applies after the prompt only, never to avatars, icons, logos or the composer.
- **Sent as a link.** Such a picture cannot be read in the page, so the extension reports its address as a link. The app downloads it with its own safe fetcher, which works like “Open image in new tab”. That path already existed for pictures on other hosts and is covered by the `images` integration test (“downloaded links”).
- **Viewer.** The picture viewer is opened only from a picture the page shows. A broken card may be a link that opens another tab.

**Tests:** new extension test “gallery pictures the page cannot show (broken-picture icons) are reported as links”. It failed on 3.2.5 (no links, after the 90 s wait) and passes now. The existing image-search test still passes.

**Not verified here:** the real ChatGPT page with this answer. Which host refused the pictures, and why, is not known; the fake uses HTTP 403.

**Commands run**
```
new broken-picture test on 3.2.5    # failed: expected 4 links, received []
npx tsc --noEmit                    # 0 errors
npx vitest run                      # 44 files, 305 tests pass
npx vitest run --config vitest.integration.config.ts tests/integration/extension.test.ts   # 35/35
```
The app's code did not change in this step, only the expected extension version. The `images` integration test (10/10, including the downloaded gallery links) passed in the run before it.

## Owner report: another site's designed thumbnail became half of a featured image (photo check on by default)

**Reported by the owner** (screenshot, Techeflux):
- The two-photo featured image showed, on its right, another site's designed thumbnail: a photo with a green circle drawn around one man, and a second man cut in.
- “The earlier tool asked ChatGPT which picture is a collage and which is not.”

**Cause**
- The photo check (ChatGPT looks at the gallery photos and says watermark / collage / what is shown) had been ported, but it was **off by default**. The earlier tool had it on (`celebrityPhotoReview: z.boolean().default(true)` in `automation-old`). So it never ran.
- Its prompt only said “a collage made from multiple images”. The earlier tool also names “a designed thumbnail with shapes, borders or boxes around photos”.
- Even with the check on, the featured image could take a collage when the photos without one did not fill all its places.
- **Reproduced:** with the previous code, the new integration test puts the “collage” photo into the two-photo featured image.

**Fix**
- **On by default.**
  - The photo check is on by default.
  - Data migration `2026-10-21-celebrity-photo-check-on` turns a saved “off” on once. It does the same for unfinished celebrity articles, whose settings were fixed when they started. Finished articles keep the settings they ran with.
  - **Regenerate Images** uses today's switch.
- **Prompt v2.** It is the earlier tool's wording, plus “a photo inside another photo, or circles, arrows, shapes, borders or boxes drawn around or over people”. A prompt saved unchanged as v1 is upgraded; a customised prompt is kept.
- **Answer parser.** It reads answers as the earlier tool did: bold numbers, “Photo 2”, any field order, ja/nein. A description that calls the picture a collage (“side by side”, “photo grid”, “montage” …) counts as one.
- **Collages are never used while there is a single photo.**
  - With one usable photo, the two-photo design falls back to the single-photo design.
  - With only collages, the featured image takes one, and the notes say so (“Upload photos on the Images tab to replace it”).
  - Body images never use a collage.
- **A failed check never stops the images.** As in the earlier tool, the notes say “Photo check skipped (…)”.

**Tests**
- New integration test: a gallery with a designed thumbnail. The two-photo featured image uses the two plain photos and never the thumbnail. With only collages, the featured image takes one, with the note. The first part fails on the previous code, which used the thumbnail.
- Unit test: the migration (global and unfinished articles on; finished ones kept), and Regenerate Images refreshing the switch.
- Unit test: the earlier tool's answer formats. It fails on the previous strict parser.
- The existing photo-check test now runs with the default. The ChatGPT-gallery test allows the photo check's own new chat; the article chat stays the same.

**Not verified here:** ChatGPT's real answers to the v2 photo check.

**Commands run**
```
new collage test on the previous pipeline   # failed: the “collage” photo was in the featured image
new parser test on the previous parser      # failed: “Photo 2: watermark=ja | alt=… side by side …” not read
npx tsc --noEmit                    # 0 errors
npx vitest run                      # 44 files, 307 tests pass
npx vitest run --config vitest.integration.config.ts
                                    # 10 files, 85 pass, 1 skipped (real MediaPipe: MP_SRC not set)
images integration test after the Regenerate Images change   # 10/10
next build                          # compiled
```

## Owner reports (2026-10-21, evening): delete in the keyword queue; deleted articles counted as duplicates; “Writing” under the title; the Quick Bio before the introduction; 3 of 10 gallery photos (extension 3.2.7)

### 1. Delete in the workflow keyword queue
- **Asked for:** the queue (Workflow → Keyword queue) had Retry/Skip/Restore, but no Delete. Rows like “The article was deleted by you.” or “The post was changed to trash in WordPress” could not be removed.
- **Delete button:** the selection bar has **Delete** with a confirmation. It removes the keywords and their slot reservations.
- **Articles:** when a selected keyword has an article, a checkbox offers to delete the articles from the app too. It uses the same delete as the article queue, so a report backup is written first and a running article is deleted when it stops. Without it, the article stays; a running one continues as a normal article.
- **WordPress:** never changed.

### 2. A deleted article must not count as a duplicate when it is written again
- **Cause:** deleting an article removed the task, but its WordPress post stayed in the website's post index (used for internal links). Bulk Campaigns therefore marked the keyword **“Already published: …”** (EXISTING_POST → DUPLICATE), and the duplicate pre-check warned about it. Other articles' duplicate findings that pointed at the deleted article also stayed.
- **Fix:**
  - On delete, the article's post is remembered (setting `deleted-article-posts`). The campaign preview and the duplicate pre-check skip it. Its keyword is cleared in the post index.
  - The post stays in the index for internal links while it is on the website. WordPress is not changed.
  - Duplicate findings of other articles that pointed at the deleted one are removed with it.
- **Note:** if the old post is still published, writing the keyword again creates a second post. Trash the old one in WordPress if it is not wanted.

### 3. “Writing” under the title, the title repeated, the Quick Bio before the introduction
- **What happened:**
  - Every article showed “Writing” under its title.
  - Some showed the Quick Bio right after the title, then the title again as a heading, then the introduction.
- **Cause:**
  - ChatGPT now shows long answers in a **writing block** (owner's screenshot: a card labelled “Writing” with Copy and expand buttons). The extension took the label as the answer's first line.
  - With “Writing” as the first line, the cleaner did not recognise the following title line, so the title stayed in the body as an H2.
  - The assembly then took “Writing” as the introduction and put the Quick Bio after it.
- **Fix:**
  - **App:** `cleanModelMarkdown` drops a line that is only “Writing”/“Schreiben” before looking for the title. The title is compared loosely (case, punctuation).
  - **Assembly:** it drops such a paragraph, and a first heading that repeats the post title, so articles saved before the fix are cleaned when they are assembled again (for example by Regenerate). A line with real text (“Writing is his second career.”) stays.
  - **Extension 3.2.7:** it skips the writing block's label when it reads an answer.
- **Already-saved drafts in WordPress are not changed by this.** Regenerating the article's text or images re-assembles it, or remove the line in WordPress.

### 4. Only some of ChatGPT's 10 gallery photos were saved (Lola Simone Rock)
- **What happened:**
  - The answer showed 3 thumbnails with “+10”, and a viewer with a Next arrow.
  - The extension saved 10 pictures, but only 6 were different (exact copies are stored once), so 4 of ChatGPT's photos were missed.
  - The article itself uses 3 images (featured, body 1, body 2) by design.
- **Likely cause:**
  - The viewer keeps its other pictures in the page, hidden.
  - At each step the extension took the largest *file* in the viewer, not the picture it showed, and read it before a sliding viewer had changed. So it got the same pictures again.
  - Reproduced on the fake page (`galleryShown: 3`, `galleryViewer: 'strip'`): 3.2.6 saved 1 large picture of 10.
- **Fix — extension 3.2.7:**
  - each step takes the picture the viewer shows (visible, loaded, largest on screen);
  - it waits up to 6 s for a different picture after Next;
  - it stops when nothing new comes or the viewer comes back to a picture already taken.

### Tests
- **Unit:**
  - keyword Delete, with and without articles; slot reservation removed;
  - a deleted article's keyword is no longer a duplicate (campaign preview READY), and its duplicate findings are removed. Both fail on the previous code.
  - the Anika Bissel answer (“Writing”, title, article) cleans and assembles with the Quick Bio after the introduction;
  - a body saved before the fix is cleaned at assembly. Both fail on the previous code.
- **Extension (fake page):**
  - an answer in a writing block is saved without “Writing”. It fails on the 3.2.6 adapter.
  - 3 thumbnails with “+10”: all 10 large pictures are saved. 3.2.6 saved 1.

**Not verified here:** the real ChatGPT writing block and gallery viewer markup. The fixes rest on the screenshots.

### 5. Search Console: a website added as a URL-prefix property
- **Reported by the owner** (screenshots):
  - Easy Vibs is in Search Console as **https://easyvibs.co.uk/** (URL prefix);
  - the app asked for **sc-domain:easyvibs.co.uk**, and Google refused: “User does not have sufficient permission for site 'sc-domain:easyvibs.co.uk'”.
- **Fix:**
  - **Detection.** The service account's own list of properties (`GET /webmasters/v3/sites`) decides which property to use.
    - The configured property is kept when the account can use it.
    - Otherwise the first usable property of the same website is used: the domain property, then the URL prefix of the website address, then its www / non-www and http variants. An unverified entry or another website's property never stands in.
  - **Saved and logged.** A detected property is saved on the website and logged (“Search Console property https://… detected (…; sc-domain:… is not shared with it)”). The page then shows the property in use.
  - **Where it applies:** sync, the indexing checks and **Test connection**. Test connection now also says which properties the account can use.
  - **When nothing matches,** the error names the properties the account can use and how to add it in Search Console.
- **Tests (fake Google):**
  - only `https://easyvibs.example/` shared while `sc-domain:easyvibs.example` is set: the sync works on the URL-prefix property and saves it. On the previous code it fails with the owner's message.
  - the rules for picking (configured first, domain, address, www/http; unverified and other sites never);
  - a website without any shared property gets the new message.
- **Not verified here:** the owner's real Search Console account.

### Commands run
```
new tests on the previous code       # keyword delete, deleted-article duplicate, Writing/title (2), writing block,
                                     # 10-picture viewer (1 of 10 saved), URL-prefix property: all failed as expected
npx tsc --noEmit                     # 0 errors
npx vitest run                       # 44 files, 314 tests pass
npx vitest run --config vitest.integration.config.ts
                                     # 10 files, 87 pass, 1 skipped (real MediaPipe: MP_SRC not set); extension 37/37
next build                           # compiled
```
The integration run started before the Search Console change. That change touches no code the integration tests run; its own tests are unit tests (`search-console-live`, 9/9).
The keyword Delete button and its dialog were not clicked in a browser here (typecheck and build only).

## Owner requests (2026-10-22): Celebrity and Tigram image templates, a circle photo place, a search box and a clearer menu

### Celebrity and Tigram image templates
- **Image Template** has two template sets, **Celebrity image template** and **Tigram image template**. Each has a featured and a body design.
- The Tigram set is saved as `imageSettings.tigram`. Until it is changed it is the Celebrity designs (“Same as Celebrity until you change it”). Saved settings without it read as before.
- **Tigram featured design (on by default):**
  - ChatGPT is asked for the featured picture **without text**. The plan's sentences about written title text are dropped, and “No text, letters, words or numbers anywhere in the picture (the title is added later on top of it)” is added.
  - The picture goes into the Tigram featured design, whose title layer writes the title.
  - Switched off, the earlier behaviour returns: ChatGPT writes the short title on the picture, which gets the body design (logo).
- **Copy from Celebrity / Copy from Tigram** copies the other set's featured and body designs. Undo goes back; *Save templates* keeps it.
- A Tigram featured design with two picture places falls back to the single-photo preset with a note, because a Tigram article has one featured picture.

### Circle photo place
- Photo places (and fixed photos) have **Shape** (Rectangle / Circle) and a **Border** (colour, width).
- A circle cuts the photo to a circle, with the ring drawn inside the place. The editing canvas shows the same.
- **Toolbar:** *Circle photo slot* adds a square circle place with an accent ring.
- **Preset:** *Photo with circle photo* (owner's example): main photo across the canvas, the second photo in a circle with an accent ring, and the logo top left.

### Search box and clearer menu
- **Search box** above Overview (Ctrl+K or “/”):
  - it filters the menu pages, case- and accent-insensitive; a section that matches keeps its pages;
  - Enter opens the first page;
  - “Articles: …” opens Article History filtered by the words.
- **Menu headings:** Articles, Websites, Content tools, Growth & publishing, System, in the same order as before. Sub-pages sit on a guide line under their page.

### Tests
- **Renderer:** a circle place shows the second photo inside, the main photo in the box's corner outside the circle, and the accent ring at the edge; the preset uses slot 2 for the circle.
- **Template sets:** old settings read as before, and editing Tigram leaves Celebrity unchanged; the plan's title-text sentences are removed.
- **Pipeline (integration):** the Tigram featured design takes the featured picture (asked for without text) while Celebrity keeps its split design. The “title on the picture” behaviour is tested with the switch off.
- **Sidebar search:** filtering rules.
- **Chromium (`next dev`, scratch database):** clicked through Tigram tab, circle preset, circle slot (Shape = circle), Copy enabled, Save, and sidebar search “plag” then Enter opens Plagiarism Evidence. No console errors. The new menu was checked in dark and light themes.

### Commands run
```
npx tsc --noEmit                    # 0 errors
npx vitest run                      # 45 files, 321 tests pass
npx vitest run --config vitest.integration.config.ts   # 10 files, 88 pass, 1 skipped (real MediaPipe)
next build                          # compiled
```
The integration run started before the menu headings were added. They change only the sidebar markup; it was checked in Chromium.

## Owner requests (2026-10-22, later): request indexing as the owner does it; photos in the article's chat; optional variables in the Tigram image plan (extension 3.3.0)

### 1. Request indexing as the owner does it (URL Inspection → Request indexing), not by resubmitting the sitemap
The owner: “I first inspect the URL, then click Request indexing.” Google has no API for that button: the URL Inspection API only reads the status, and the Indexing API is not used. So **Automation Chrome clicks it**, with the Google account the owner signs in there.
- **Queue** (`src/lib/gsc/request-indexing.ts`, new queue `gsc`): about 35 s after a verified publish, with the workflow switch on, one request per keyword is queued (idempotent: `gsc-index:<keywordId>`). The keyword shows “Waiting for Automation Chrome to request indexing…”. It does not need the service-account key. Without a property the website's URL is used as a URL-prefix property, as the workflow page's link does.
- **Extension 3.3.0:**
  - `background.js` sees waiting requests in the `hello` answer and claims one (`gsc-claim`, 8-min lease). It opens `https://search.google.com/search-console/inspect?resource_id=<property>&id=<url>` in a background tab, and closes the tab afterwards.
  - The new content script `gsc.js` waits for the inspection result (≤ 90 s) and clicks **REQUEST INDEXING**. It then waits (≤ 4 min) while Google tests the live URL, and reports what Google said (`gsc-result`).
  - It reads English and German Search Console. It only reads the page text and clicks that one button.
  - While Google works, `gsc.js` sends a small “alive” message every 10 s, so Chrome does not stop the extension background in the middle. If Chrome restarted it anyway, the restarted background still reports the answer it receives (with the job id) and closes the tab.
  - A report is accepted only from the extension that holds the job (ACTIVE, `lockedBy`). A late or repeated report changes nothing.
  - Google's sign-in page and Search Console's start page for signed-out visitors (`/search-console/about`) both count as “not signed in”.
  - **New host permission:** `https://search.google.com/*`.
- **Outcomes:**

  | Outcome | What happens |
  | --- | --- |
  | Indexing requested | The keyword becomes INDEXING_REQUESTED with Google's sentence and “a request is not proof of indexing”. |
  | Daily limit (“Quota exceeded”) | Asked again in 20 h. |
  | Google sign-in page | “Sign in to Google (Search Console) in Automation Chrome”; asked again in 1 h. |
  | A Google check (reCAPTCHA) | Left to the owner; asked again in 1 h. |
  | No access / URL not in property | Failed, with what to do. |
  | Other errors | Retried hourly, failed after 4 tries with “request it yourself in Search Console”. |

  - Google's checks and sign-in are reported, never handled.
  - A request still waiting stays visible next to Google's index status (“· Request indexing: …”).
  - A late report never moves an INDEXED keyword back.
  - A request for a URL Google already shows as indexed, or for a deleted keyword, is cancelled instead of opened.
- **Proof unchanged:** INDEXED only from Google's URL Inspection API verdict PASS (needs the key). The sitemap code was removed (`listSitemaps`/`submitSitemap`).
- **Chrome autostart:** waiting `gsc` requests count as work, so Automation Chrome is opened for them like for ChatGPT work.
- **Workflow switch help text** describes the new flow.

### 2. Celebrity photo search and photo check in the article's chat
- The owner: a new ChatGPT chat was opened for the photo search, and another one for the collage check. They want the prompts in the chat where the article was written.
- Now `IMAGE_SEARCH` (first try) and `PHOTO_CHECK` are sent to the article's conversation (`newChat: false`). Stages run one after another, so nothing else is in that chat at the same time. The gallery is read only from the answer to its own prompt (turn-scoped, unchanged).
- Only when that search answers with text only is it asked **once more in a new chat**, as before.
- The Tigram image prompts already used the article's chat (only a repeat goes to a new chat).

### 3. Tigram image plan: `{{keyword}}` and `{{image_title}}` optional
- Both are now `required: false` in the shipped definition.
- The seed updates the variable list of existing prompt rows, without touching the owner's prompt text. An own image-plan prompt without them saves without “Required variable … is not used” warnings.

### Tests
- **Unit** (`search-console-live.test.ts`, fake Google):
  - the request is queued at 36 s; there is no sitemap call; the payload is right;
  - a second tick does not queue it again; a claim is leased;
  - REQUESTED → INDEXING_REQUESTED → INDEXED by URL Inspection;
  - signed out → retried in 1 h, with the note next to Google's answer;
  - a late REQUESTED never moves INDEXED back; an already-indexed URL is cancelled;
  - quota → +20 h; no access → failed; an unknown job is refused;
  - without a key the request is still queued; without a property the website URL is used.
- **Extension (Playwright Chromium with the real extension, fake Search Console** `tests/fixtures/fake-search-console.ts`):
  - the URL Inspection page opens with the right `resource_id`/`id`, REQUEST INDEXING is clicked once, the keyword becomes INDEXING_REQUESTED, and the tab is closed;
  - daily limit, a Google sign-in redirect and Search Console's signed-out start page are reported and scheduled again.
- **Images (integration):**
  - the photo search and photo check are claimed in the article's chat (`newChat` false, the article's conversation URL);
  - a text-only search is asked again in a new chat (`[false, true]`).
  - These two failed on the previous `images.ts` (checked by swapping it back).
- **Prompts:** IMAGE_PLAN variables optional after seeding over a row marked required; an own prompt without them saves with no warnings. This failed on the previous defaults.
- **Permission test:** the narrow host list now includes `https://search.google.com/*`; still no blanket permission.

### Commands run
```
npx tsc --noEmit                    # 0 errors
npx vitest run                      # 45 files, 324 tests pass
npx vitest run --config vitest.integration.config.ts   # 10 files, 90 pass, 1 skipped (real MediaPipe); extension 39/39
next build                          # compiled
```
- **Final code:** the full integration run started before the last extension changes (report only from the job's holder, “alive” messages, Search Console's start page as signed out). After them, tsc, the unit suite and the two Search Console extension tests were run again: all pass.
- **Checked by swapping the previous code back:**
  - without the start-page rule, the start-page case times out;
  - the image-chat tests and the prompt test also fail on the previous code.

### Not verified here
- The “background restarted while Google answered” path: Playwright keeps the extension background attached, so Chrome never stops it in tests.
- The real Search Console page: its button and dialog texts are matched in English and German from Google's wording, but they were not seen live here.
- Google's real daily limit.
- The owner's signed-in Google account in Automation Chrome.
- Live ChatGPT with the photo search in a long article chat.

## Owner report (2026-10-22): a draft stopped by the duplicate check could not be continued (“malaak compton-rock”); “Force continue”

**Report:** the keyword queue showed “failed” with “Draft #1344 saved but not published: 12 % of the wording (longest identical run 68 words, 5 identical paragraph(s)) repeats ‘Who Is Malaak Compton-Rock? All About Chris Rock's Ex-Wife’ on Techeflux … Fix the draft, then publish it yourself or retry here.” Then: “add an option, force continue”.

**Why it was stuck:**
- The article is COMPLETED with a verified draft and `publishBlocked` (a hard stop while review holds are off).
- Retry only retried FAILED, NEEDS_REVIEW or CANCELLED articles, so it put the keyword back to WRITING. The next scheduler tick found the same block and set it to FAILED again.
- Editing the draft in WordPress does not clear the block either.
- **Reproduced on the previous code:** Retry answered “1 updated”, and the next tick set FAILED with the same message.

**Fix:**
- **Force continue** on the keyword queue's selection bar (`keywordAction` action `force`):
  - a dialog lists every selected stopped keyword with its problems;
  - **a saved draft with `publishBlocked`:** the block is lifted, and the problems are kept as `publishForced {at, problems}` on the article;
  - **a duplicate finding** gets the existing duplicate override (reason “Force continue from the workflow keyword queue”), and its open Duplicate Review matches become OVERRIDDEN;
  - `task.force-continue` is audited;
  - the keyword goes back with the next free slot, and the scheduler treats the draft like any verified draft: READY, then scheduled for its slot.
  - **An article held for review** (review holds on) gets “Approve despite review reasons” with the same reason.
  - **An article that failed for another reason** (e.g. the composer) is not forced: “Use Retry”.
  - **A keyword that is not stopped** is left alone.
- Publishing still needs the website's publishing permission (acknowledgement); nothing else about publishing changed.
- **Retry** on such a keyword now changes nothing and says to use Force continue.
- **The keyword message** now says: “Publish it yourself in WordPress, or select it and use Force continue to publish it at the next free slot anyway.”

**Not changed:** the duplicate check itself. The draft really repeats about 12 % of the other article's wording, including 5 whole paragraphs; Force continue is the owner's decision to publish it anyway.

**Tests** (`tests/unit/workflow-force-continue.test.ts`, failing on the previous code):
- **Stopped draft:**
  - Retry changes nothing and gives the note;
  - Force continue lifts the block, records the problems, overrides the duplicate match, writes the audit row and reserves a slot;
  - the next scheduler tick makes it READY.
- **Not forced:** a waiting keyword and a technically failed article.
- **Held for review:** the article is re-queued with the quality override.
- **Chromium (`next dev`, scratch database):** select the stopped keyword → Force continue → the dialog lists the duplicate problem → confirm. The API answered `changed: 1`, the row shows “writing … Forced by you”, and there were no console errors. Checked on a warm and on a freshly started server.
  - A first try reported 200 but changed nothing, with no audit row. That script closed the browser about 3 s after the click, while the route was still compiling, so the request never reached the handler. Both later runs waited for the response.

**Found while running the suite:** `workflow-scheduler.test.ts` (“write-ahead horizon …”) had begun to fail on the unchanged code as well (checked with `git stash`).
- **Cause:** its calendar check looked for FREE slots in a fixed window (2026-10-20 to 10-23). `calendar()` counts free slots from the real clock, because a past slot is never free, so after 10:00 UTC on 2026-10-22 that window had none.
- **Fix:** the test now looks for free slots in the coming three days. The reserved-slot check keeps the fixed window. The app is unchanged.

**Commands run**
```
npx tsc --noEmit                    # 0 errors
npx vitest run                      # 46 files, 327 tests pass
npx vitest run --config vitest.integration.config.ts tests/integration/workflow-publish.test.ts   # 6 pass
next build                          # compiled
```
**Not verified here:** the owner's real keyword, draft #1344, and its publication in WordPress.

## Owner requests (2026-10-22): more fonts (“like Helvetica”), an editor that stays in view, pickers in the app's look

**Requests:**
- “Add more good fonts to the image text, like Helvetica.”
- “When I edit a text, the live preview / editor goes up and the text stays below; make it user friendly.”
- With a screenshot of Chrome's colour popup: “fix the UI of all menus of this type, calendar etc.”

### Fonts
- **Choices:** 20 free fonts are added to the 4 system fonts, grouped in the font list. Each name is shown in its own font (Chrome's customizable select).
  - Arimo has the same letter widths as Helvetica/Arial; Helvetica itself is not free to ship.
  - The others: Inter, Roboto, Open Sans, Montserrat, Poppins, Lato, Raleway, Nunito, Oswald, Bebas Neue, Anton, Archivo Black, Barlow Condensed, Playfair Display, Merriweather, Lora, DM Serif Display, Dancing Script and Pacifico.
- **Files:** `public/fonts/<font>/` holds the Fontsource 5.3.0 packages' Latin WOFF files (English and German letters) for weights 400/600/700/800 where they exist, plus each LICENSE.txt (SIL OFL 1.1). 1.8 MB in all.
- **Why the renderer draws them from the files:** before, text was SVG text, so it depended on the fonts installed on the computer, and Helvetica, for example, is not on Windows.
  - Now text in a bundled font is turned into shapes from the font file (new dependency `opentype.js` 1.3.4, published 2021, pinned; types `@types/opentype.js` 1.3.8). The picture is the same on every computer.
  - Lines are broken by the real letter widths instead of an estimate.
  - A text with a letter the font does not have (e.g. Chinese) is drawn with system fonts as before, never with boxes.
  - The 4 system fonts render exactly as before.
- **Missing weights:** a weight the font lacks uses the nearest one, in the picture and on the canvas. The weight list says so, and the browser never fakes a bold.
- **Designer canvas:** the same files are loaded with @font-face (served from `/fonts`; the CSP already allows `font-src 'self'`).

### Editor layout
- **Sticky editor:** on wide screens (≥ 1280 px) the toolbar, canvas and preview controls stay in view while the right-hand panels scroll. Fit-zoom sizes the canvas to the window.
- **Right-hand panels:** the selected layer comes first, then Layers, then Template. For a text layer, its Text, Font and Weight come before position and size.
- **Edit / Real output** switch above the canvas: Real output shows the production renderer's picture at the same size.
- **Preview controls:** the preview title, photo slots and **Check final size** sit in one row under the canvas.

### Pickers in the app's look
- **Colour:** new `src/components/color-picker.tsx` replaces both browser colour popups in the designer (layer colours and the accent).
  - Saturation/brightness area and hue bar, with mouse and keyboard (arrows, Shift ×10);
  - hex and R G B fields;
  - the screen eyedropper in Chrome;
  - swatches with the template's accent;
  - opens above or to the left near a window edge; Escape closes it.
  - The designer's arrow-key nudge and Delete ignore keys typed inside such popups.
- **Time:** new `src/components/time-picker.tsx` for Workflow → Publishing slots (hour, minute and AM/PM columns, every minute). It replaces typing “3:30 PM”.
- **Dates:** date fields already use the app's own calendar (`DatePicker`). No `<input type="date">` or `type="color"` is left in the app.

### Checked
- **Unit tests** (`images.test.ts`):
  - every bundled weight loads and has its license, and nearest weights are right;
  - the schema accepts the new fonts and refuses unknown ones;
  - real-width line breaking (“iiiiiiii iiiiiiii” fits on one line where “WWWWWWWW WWWWWWWW” needs two), with an ellipsis when cut;
  - rendered ink: Montserrat > 1000 px wide, Bebas Neue under 75 % of it;
  - Chinese letters fall back to system fonts.
- **A rendered sample sheet** of all 24 fonts with German letters, checked by eye.
- **Chromium against `next dev`** (scratch database, dark theme):
  - 24 fonts in 5 groups; Montserrat chosen;
  - after scrolling the page 900 px, the canvas stays at the top of the window;
  - the colour picker opens, an area click and Shift+→ on the hue set `#cc4429` on the field;
  - Real output shows the renderer's Montserrat text;
  - the slot picker gives “4:45 PM”;
  - no console errors.
- **`scripts/a11y-audit.ts`:** 58/58 pages (dark and light) with no serious or critical violations, the designer and Workflow included. The pickers were closed during the audit.

**Commands run**
```
npx tsc --noEmit                    # 0 errors
npx vitest run                      # 46 files, 329 tests pass
npx vitest run --config vitest.integration.config.ts tests/integration/images.test.ts tests/integration/image-tools.test.ts   # 16 pass, 1 skipped
next build                          # compiled
BROWSER_CHANNEL=chromium npx tsx scripts/a11y-audit.ts http://127.0.0.1:3100   # 58 ok
```

**Not verified here:** the owner's Windows PC and Chrome; the font list's per-font preview needs Chrome's customizable select (Chrome 135+), and other browsers show plain names.

## Owner report (2026-10-22): “published today, but the calendar shows it tomorrow” (malaak compton-rock)

**Report:** the Publishing Calendar showed “malaak compton-rock — published (verified)” on Friday 23 October, 5:00 PM, although it was published on the 22nd. The owner asked for a way to correct it.

**Cause:**
- The owner published the stopped draft in WordPress (the old keyword message said “publish it yourself”).
- Force continue then gave the keyword the next free slot, Friday 5:00 PM.
- When the scheduler came to schedule it, WordPress already showed the post as published. `scheduleKeywordPost` recorded PUBLISHED with the real publish time (`publishedAt`), but kept `scheduledAt` (the slot the calendar shows) and the slot's reservation.
- `verifyKeywordPublished` had the same gap.
- **Reproduced first:** an integration test on the fake WordPress, with the post published 2 h ago and the slot tomorrow. On the previous code `scheduledAt` stayed on tomorrow's slot.

**Fix:**
- **One place records a publication** (`markPublished` in `src/wordpress/schedule.ts`). When WordPress's publish time differs from the slot by a minute or more:
  - the keyword's calendar time becomes the real publish time;
  - the reserved slot is released, so another article can use it;
  - a log line says so.
- A post published at its slot is unchanged.
- **Data migration `2026-10-22-published-at-real-time`:** published, indexing-requested and indexed keywords recorded before this get the same correction once. It runs with the next `npm run start:all`, and a backup is written to `data/backups/migrations/` first.
- No button is needed: it corrects itself.

**Tests:**
- `workflow-publish.test.ts`, new: published by the owner before its slot → PUBLISHED at the real time, the reservation is gone, the calendar entry is at the real time, and no publish permit was used.
- `workflow-force-continue.test.ts`, new: the migration moves the off-slot keyword and frees its slot, keeps the on-slot one with its reservation, runs only once, and writes a backup.

**Commands run**
```
npx tsc --noEmit                    # 0 errors
npx vitest run                      # 46 files, 330 tests pass
npx vitest run --config vitest.integration.config.ts tests/integration/workflow-publish.test.ts tests/integration/migration-upgrade.test.ts   # 8 pass
next build                          # compiled
```
**Not verified here:** the owner's database; the migration runs there at the next start.

## Owner report (2026-10-22): “how do I know indexing was requested? I never signed in to Search Console in Automation Chrome”

**Report:** four published keywords showed “Sign in to Google (Search Console) in Automation Chrome, then the request is made automatically. Asked again …”. The extension had found Google's sign-in page, as designed, but the owner had no way to see the state at a glance, or to sign in from the app.

**Added:**
- **“Indexing in Search Console” panel** on the Workflow page (when the switch is on or posts are published) and on the Automation Chrome page (`src/components/indexing-panel.tsx`, `GET /api/search-console/indexing`). It shows:
  - whether Automation Chrome is signed in to Google, judged from the last answer: a request or the daily limit means signed in, Google's sign-in page means not;
  - how many requests were made and how many wait;
  - what they wait for (sign-in, daily limit, Google check);
  - the last answer, with its URL and time.
- **Sign in to Google in Automation Chrome:** a new control job `chrome.google-signin` opens Google's sign-in page in Automation Chrome, continuing to Search Console (a new window when it is already running).
  - The owner types the password themselves; the app never sees it.
  - Automation Chrome is a normal Chrome without automation flags, so Google allows the sign-in, as it does for ChatGPT.
- **Request now:** the requests that waited for the sign-in, a check or an error are made now instead of within the hour. The daily limit still waits.
- **After the first successful request**, requests that waited for the sign-in are made next, without pressing anything.
- **How the owner knows:** the keyword changes from “published” to “indexing requested”, with Google's sentence and the time. The panel counts it.

**Tests** (`tests/unit/indexing-signin.test.ts`):
- **Signed out:**
  - the overview reports two waiting for sign-in and one for the daily limit;
  - “Request now” makes the two due and leaves the daily limit;
  - a successful request brings the rest forward, and the overview then says signed in.
- **Sign-in button:** it enqueues one `chrome.google-signin` control job (no duplicate while one waits); an unknown action is refused; the worker has the handler; the sign-in URL is fixed.
- **Chromium (`next dev`, scratch database):**
  - both panels show “Google not signed in”, 2 waiting, and the last answer;
  - the sign-in button queued the job;
  - Request now answered `count: 2`;
  - no console errors.
- **`scripts/a11y-audit.ts`:** 58/58, no serious or critical violations.

**Commands run**
```
npx tsc --noEmit                    # 0 errors
npx vitest run                      # 47 files, 332 tests pass
next build                          # compiled
BROWSER_CHANNEL=chromium npx tsx scripts/a11y-audit.ts http://127.0.0.1:3100   # 58 ok
```
**Not verified here:** Google's real sign-in page in the owner's Automation Chrome.

## Owner request (2026-10-22): a screenshot as proof that indexing was requested (extension 3.4.0)

**Request:** with a screenshot of Search Console's green “Indexing requested” dialog: “after the indexing request, show a screenshot like this as proof, so I know.”

**Why not a plain screen capture:**
- `chrome.tabs.captureVisibleTab` needs either access to every website (`<all_urls>`) or a click on the extension at that moment. It also fails when the window is minimized (the owner keeps Automation Chrome minimized), and the requests run in a background tab.
- This project keeps the extension's website access narrow, so the screen capture was not used.

**How it works:**
- **Extension:** the new `pageCapture` permission lets the extension save the page itself as it stands: an MHTML copy of the page with its styles and pictures. It works in a background tab and a minimized window.
  - After Search Console answers “Indexing requested” (or the daily limit), the extension waits for the dialog to finish opening and saves the copy.
  - It uploads the copy before reporting the result, because the dashboard takes it only while the request is still open. A copy that cannot be saved never stops the request.
  - Chrome keeps the copy in a temporary file that it sometimes drops before it can be read (“A requested file or directory could not be found”): about half of the runs at first. A fresh copy is now taken, up to three times; after that, 6 of 6 runs passed.
- **Dashboard** (`POST /api/extension/gsc-proof`, `src/lib/gsc/proof.ts`):
  - **Who may upload:** only the extension holding that request (ACTIVE, `lockedBy`), with the connection key, from localhost.
  - **What is accepted:** only an MHTML file (its MIME header) of at most 15 MB, stored in `data/uploads/gsc-proof` with mode 600.
  - **Rendering:** a `gsc.proof` control job makes the worker open the copy in a headless browser with scripts off and every network request blocked, and take a 1366×900 PNG.
  - **Storage:** the PNG is stored with the article (media role `INDEXING_PROOF`, the post URL as its source), and the copy is deleted.
- **Where the owner sees it:**
  - **Search Console screenshot** link on the keyword in the keyword queue;
  - the latest screenshot (thumbnail) in the Indexing in Search Console panel.
- **What it proves:** the screenshot shows what Search Console showed after the click. Whether the page is indexed still comes only from Google's URL Inspection.

**Tests:**
- **Extension, real extension in Chromium with the fake Search Console:**
  - after the request, the page copy was saved and uploaded (it contains “Indexing requested”);
  - the worker made a 1366×900 PNG stored as `INDEXING_PROOF` with the post URL;
  - the copy was deleted;
  - the keyword queue links the screenshot.
  - The fake page has no styles, so its screenshot is plain text; a styled page renders with its styles, as checked separately.
- **Permission test:** the narrow host list is unchanged. The permissions add `pageCapture`, with the reason written in the test.

**Not verified here:**
- The real Search Console page saved and rendered.
  - Its styles are in the copy only if Chrome had loaded them.
  - A page that only draws with scripts would look different offline.
- Chrome's permission prompt for `pageCapture` on the owner's PC: an unpacked extension normally gets it on reload.
- **Unit test** (`indexing-signin.test.ts`): the upload is refused before the extension takes the request, refused for another extension, refused for a file that is not a page copy, and refused with a wrong key. Accepted, the copy is stored and a `gsc.proof` job is queued.

**Commands run**
```
npx tsc --noEmit                    # 0 errors
npx vitest run                      # 47 files, 332 tests pass (before the upload unit test); then indexing-signin + extension-version: 5 pass
npx vitest run --config vitest.integration.config.ts tests/integration/extension.test.ts   # 39/39
next build                          # compiled
```


## Owner report (2026-10-22): the tool's URL Inspection link opens Google's “404. That's an error” (extension 3.4.1)

**Report:**
- A screenshot of Google's 404 at `search-console/inspect?resource_id=sc-domain%3Atecheflux.com&id=https%3A%2F%2Ftecheflux.com%2Fandre-rock%2F`, next to the working property page `search-console?resource_id=sc-domain:techeflux.com`.
- The owner asked: “make the tool inspect the URL in Search Console”, with a video of how they do it by hand.

**Cause:**
- The `id` of a URL Inspection link is a token Google makes (in the owner's video: `id=SOXOcM6XHI3ojqg9m4ZYAhA`), not the post's URL. Google answers 404 for a link with the URL there, so the request could never be made.
- Also, the extension's Search Console script was only allowed on `search-console/*`, so it never ran on the property's own page `search-console?resource_id=…`.

**Now, as in the owner's video:**
1. Automation Chrome opens the property's Search Console page (`search-console?resource_id=<property>`).
2. It types the post's URL into **“Inspect any URL in …”** and presses Enter.
3. When the result shows that URL, it clicks **REQUEST INDEXING**, waits for “Testing if live URL can be indexed”, and reports what Google answered (“Indexing requested”, the daily limit, …). The proof screenshot is saved as before.

**Safety:**
- Before clicking, the result must show the article's URL. Otherwise nothing is requested, and the keyword says so.
- **Fallback:** if the box is not found or nothing loads, the tab opens Google's own inspection link instead. That link (`inspectionResultLink`) comes from the URL Inspection API when the Search Console key is set; it is fetched when the request is queued.
- A 404 page sends the tab back to the property page once. Over four page changes in one request end it as an error.
- The extension's site access is unchanged (`https://search.google.com/*`); only the content script's page pattern is now `https://search.google.com/search-console*`.
- **What changed in the app:** the keyword queue link now opens Google's inspection link when the app has one (“inspect in Search Console”), otherwise the property's Search Console page (“open Search Console”). It never builds a link with the post's URL again.

**Tests:**
- **Reproduced first.** The fake Search Console now answers like Google: 404 for an inspection link whose `id` is not one of its tokens. It has a property page with the “Inspect any URL in …” box. With the old code the request timed out on that 404.
- **Extension, real extension in Chromium:**
  - **Normal path:** the property page opened, the URL was typed once, REQUEST INDEXING was clicked once, INDEXING_REQUESTED was recorded, the proof was saved, and the tab was closed.
  - **New test, no box on the page:** Google's inspection link from the API is opened instead; nothing is typed, there is one click, and INDEXING_REQUESTED is recorded.
  - **Daily limit and signed out:** still reported and asked again later.
- **Unit:** a claimed request carries the property page, plus Google's link as the fallback, and the queued request keeps that link. The scheduler test uses the new property-page link.

**Not verified here:**
- The real Search Console page.
- Whether Google's real “Inspect any URL” box accepts the typed URL and the synthetic Enter. If it does not, the fallback link is used when the Search Console key is set; otherwise the keyword shows “The ‘Inspect any URL’ box was not found…” or “did not load within 90 seconds after typing the URL”.
- The box is found by its label (“Inspect any URL in …”, German “URL … prüfen/untersuchen”). Other UI languages are not recognised.

**Commands run**
```
npx vitest run                      # 47 files, 333 tests pass
npx vitest run --config vitest.integration.config.ts tests/integration/extension.test.ts -t "Search Console"   # 3/3 (typing 8.5 s, fallback 51 s, limit/sign-out 9 s)
npx vitest run --config vitest.integration.config.ts tests/integration/extension.test.ts tests/integration/workflow-publish.test.ts   # 2 files, 47/47 (extension 40, publish 7)
npx tsc --noEmit                    # 0 errors
next build                          # compiled
```

## Owner request (2026-10-22): a “Request indexing” option on the keyword queue

**Request:** with a screenshot of the keyword queue's selection bar: “add a request indexing option here”.

**What it does:**
- **Request indexing** (new, on the selection bar): Automation Chrome makes the Search Console request now for the selected published keywords, as described in the 3.4.1 section above.
  - It also works when the workflow switch “Request indexing after publishing” was off.
  - It works when an earlier request was answered (requested, daily limit, error). That request is asked again, so there is still one request per keyword.
  - A request Automation Chrome is making right now is left alone.
  - An indexed keyword is left out (“already on Google”), and an unpublished one too.
  - The keyword shows “Waiting for Automation Chrome to request indexing … (asked by you …)”, and the Indexing in Search Console panel updates at once (it refreshed only every 15 s).
  - The action is audited like the other keyword actions.
- **Labels:** the two existing buttons only record what the owner did by hand, so they are now **Mark requested** and **Mark indexed**, with a tooltip. They were “Indexing requested” and “Verified indexed”, next to which a “Request indexing” button would be confusing. Their behaviour is unchanged.
- **Found while testing:** a request made a second time got no proof screenshot. The render job's key was the request's id, so the second one was taken as a repeat. The key now also carries the run's start time.

**Also in the owner's screenshot: “Index status not checked: fetch failed”.**
- That is all Node says when Google's API cannot be reached from the PC. The error behind it is now named, e.g. “Google could not be reached from this computer (ECONNREFUSED); asked again in an hour.”
- The message used to replace what happened to the indexing request. Now the request's state stays after it: waiting and why, being made now, or “Indexing requested in Search Console at …”.
- A request asked again for a keyword already marked as requested also stays visible next to Google's answer. Before, this showed only for published keywords.

**Tests (reproduced first):**
- **`indexing-signin.test.ts`, new test:** the action was refused (“Invalid option”) before.
  - It requests two published keywords: one requested before, one never queued.
  - It leaves out the indexed and the unpublished ones, with notes.
  - It shows the status, leaves a running request alone, and a second proof screenshot is queued.
  - With the old proof key, the test fails (1 proof instead of 2).
- **`search-console-live.test.ts`, new test:** with Google's API unreachable (a closed port), the status read “Index status not checked: fetch failed” before. Now it names ECONNREFUSED and keeps the request's state.
- **Chromium smoke (scratch database, dev server):**
  - three keywords like the owner's selected (two published with “fetch failed”, one indexed);
  - the bar shows Request indexing, Mark requested and Mark indexed;
  - the toast says 2 requested, and that “Jordan Rock” is already on Google;
  - both rows show “Waiting for Automation Chrome …”;
  - the panel went from no waiting request to “1 waiting” 0.46 s after the click; no console errors.

**Not verified here:**
- The request itself on the real Search Console page (as for 3.4.1 above).
- The real network error behind the owner's “fetch failed”: it is on the owner's PC; the new message will name it.

**Commands run**
```
npx tsc --noEmit                    # 0 errors
npx vitest run                      # 47 files, 335 tests pass
npx vitest run --config vitest.integration.config.ts tests/integration/extension.test.ts -t "Search Console"   # 2/2 (request with proof; limit/sign-out)
npx vitest run --config vitest.integration.config.ts tests/integration/extension.test.ts -t "404"              # 1/1 (fallback link)
next build                          # compiled
```

## Owner report (2026-10-22): faces cut in half in a group photo (“Michael Joseph Consuelos”, featured image)

**Report:** a screenshot of a two-photo featured image (WordPress media #1362). In the left photo, four people stand side by side, and the faces at both edges are cut in half.

**Cause:**
- **The crop:** it centred on the area around all main faces, the earlier tool's rule. When that area was wider than the place, the faces at both edges were cut through. The left half of the split design is 952×1080, so it keeps only about 58 % of a 3:2 photo's width.
- **The choice of photos:** it never looked at whether a photo fits its place. Photos are ordered by the biggest face, so a group photo often comes first and lands in the narrow half.

**Fix (face locations only, never who it is):**
- **Crop** (`cropBox`, `src/images/render.ts`):
  - When the main faces fit, the crop is as before.
  - Otherwise its edges are placed between faces, padded for hair and ears, never on one. It keeps as many whole faces as fit: the bigger ones first, then those nearest the middle of the group, centred when that cuts no other face.
  - If no whole face can be kept, it centres on the biggest face.
- **Choice of photos** (`photosForPlaces`, `fitsPlace`):
  - Each place takes, of the photos just as good as the next one, one whose main faces fit it whole. “Just as good” means the same photo-check flag and the same rank (face, soft).
  - A wide group photo then moves on to the 16:9 body image, where it fits.
  - A worse photo (soft, watermarked, no face) is never taken over a better one just because it fits, and the owner's uploads keep their places.
  - The Images tab notes how many photos were placed this way.
- **What is stored:** the measured face boxes and the photo's shape are kept with the stage's photo facts.
  - A stage result saved before this change has no face boxes, so it crops as before.
  - **Regenerate images** measures again (the stage state is cleared), so it uses the new crop.

**Tests (reproduced first):**
- **Unit, `images.test.ts`:**
  - **reproduction:** a 3:2 photo with four faces side by side in the split design's left place. Before, the edge faces showed 8 % and 7 % (cut). Now each face shows whole or not at all, and at least two show whole;
  - the crop window never runs through a padded face, the 16:9 place keeps everyone, and focus without face boxes crops as before;
  - **choice:** the featured halves take the pair and the single photo, the group photo goes to the body place, and a worse photo is not preferred because it fits.

**Not verified here:** the owner's photos with the real face detector. The real MediaPipe test needs `BAS_TEST_MEDIAPIPE_DIR`; the boxes here are given, not detected.

**Commands run**
```
npx tsc --noEmit                    # 0 errors
npx vitest run tests/unit/images.test.ts   # 26/26
npx vitest run                      # 47 files, 338 tests pass
npx vitest run --config vitest.integration.config.ts tests/integration/image-tools.test.ts tests/integration/images.test.ts   # 16 pass, 1 skipped (real MediaPipe)
next build                          # compiled
```

## Owner report (2026-10-23): after “Regenerate images” — a stop at “already future”, only one photo used, crops still wrong; and a pen tool

**Report, with four screenshots:**
- The WordPress step stopped: “WordPress post #1367 is already ‘future’. The app does not change live or scheduled posts in this step.”
- Two featured images were still wrong after regenerating:
  - Linda Ripa: a close-up of two faces, one cut;
  - Michael Joseph Consuelos: a selfie of three, two faces cut.
- Omikaye Phifer: “ChatGPT gave so many images and only one was used”. The Images tab listed nine collected photos, but there were no body images.
- The owner asked to try a Google tool or another idea, and to test with 12–15 real people's photos.
- Later: “add a pen tool to the image editor, to make custom photo slots and custom elements, easy like Illustrator”.

### 1. Regenerate on a post the workflow scheduled
- **Cause:** the draft step refuses every post that is “future”, “publish” or “private”. After a regenerate, the article ran the draft step again on a post the workflow itself had scheduled.
- **Now:** the post may be updated when a workflow keyword of this article is SCHEDULED and the website still allows publishing.
  - The client never sends a status, so the post stays scheduled for its slot and nothing is published early.
  - Edits made in WordPress are still never overwritten, as before.
  - The draft step's read-back and the final check accept “future” in this case only.
- **Still left alone:** a post scheduled by anyone else, or already live.
- **Test (`workflow-publish`, reproduced first):**
  - before: NEEDS_REVIEW with the owner's message;
  - now: the title change reaches the scheduled post, which stays “future” with the same date, and the only publish permit is the scheduling itself;
  - a post scheduled outside the workflow still stops, unchanged.

### 2. Regenerate used only the new search's photos
- **Cause:** a regenerate clears the stage state, so the gallery was collected again. The new search brought back two photos, the featured design took both, and the body images had none.
- **Now:**
  - the photos collected for the article before (not removed with *Don't use*) are used again, after your uploads;
  - a new search runs only when there are fewer than four;
  - the Images tab says so.
- **Test (`image-tools`, reproduced first):** after a regenerate whose search would return one picture, all three images are made from the earlier five photos with no new search. A photo marked *Don't use* is not used again.

### 3. Crops: a face or a person is never cut
- **No search engine:**
  - Google Images is not scraped: the project's rule, and Google's terms.
  - Cloud “crop hint” services would send every photo out and need a paid key.
  - The fix stays local and offline.
- **Tested on 17 real photos.** They are free-licence photos of real people from Wikimedia Commons (credits in the scratch folder; not committed): Comic-Con and conference panels, red carpets, families, a selfie of four, a B/W group, portraits.
  - The real MediaPipe detector ran on them in Chromium here.
  - Each was rendered into the split design's 952×1080 half and a 16:9 body image, and looked at.
- **Found and fixed:**
  - **The crop rule:** keeping only some of the people (the previous fix) left half bodies at the edges, as in the owner's Linda Ripa image. Now, when the main faces do not all fit a place, the photo is shown whole on a blurred copy of itself, as the earlier tool does for tall photos. Framing “Center” or “Top” still crops. Photo choice already prefers photos that fit.
  - **False faces:** in tiles, BlazeFace found “faces” on a jacket, a man's back, a logo and a poster, and an oversized box over a turned head. They all scored 0.53–0.59, while the real small faces scored 0.6–0.89. Tile detections now need 0.6 (the whole picture keeps 0.5). The oversized box had made the four real panel faces “background”, so the crop cut them.
  - **Missed faces:** a panel guest with glasses, and most of the B/W group, were cut because their faces were never found. A person detector now runs too: MediaPipe EfficientDet-Lite0, people only, score ≥ 0.5, installed by `tools:install` and preflight.
    - A person whose face was not found gets a head box at the top of their body box: a seventh of a standing person's height, about a third of a seated one's.
    - Only people at least 40 % as tall as the tallest count.
    - The head box counts like a face for fitting and centring.
    - A single portrait (a person as wide as the photo) is unaffected, because the found face is what counts.
- **Result on the 17 photos:**
  - in the narrow half, no face or person is cut through;
  - groups of four or more and the B/W group are shown whole;
  - the Comic-Con panel keeps its four seated guests whole;
  - portraits are cropped as before.
  - One panel host turned to the microphone is found by neither detector, and is left out of that crop entirely rather than cut.
- **Unit tests:**
  - the whole-photo rule, with every face whole, and the crop as before without face boxes;
  - `cropBox` for the 16:9 and narrow places, and a fitting pair cropped around both;
  - `headsOfPeople`: seated, standing, background, and a portrait with its face.

### 4. Pen tool (Image Template designer)
- **Data:**
  - pen points are stored as fractions of the layer box, with cubic-curve handles, so resizing the box keeps the shape;
  - a photo place can have shape “path”;
  - a new `path` layer draws a filled shape or an open line;
  - the template schema validates both.
- **Drawing:**
  - **Pen shape** (key P) and **Pen photo slot** in the toolbar, with a hint bar, **Finish** and **Cancel**;
  - click for a corner, click and drag for a curve (mirrored handles);
  - click the first point to close; Enter or a double click finishes; Backspace or Ctrl+Z removes the last point; Esc cancels.
- **Editing a selected pen layer:**
  - drag a square to move a point, drag a round handle to bend the curve (Alt: one side only);
  - double-click a point: corner ↔ curve; double-click the line: add a point, splitting the curve so the shape stays; Alt-click a point: remove it;
  - each drag is one undo step, and the layer box follows the drawn line, curves included.
- **Properties:** fill, border and “Closed shape”. *Use as photo slot* turns a closed shape into a photo place; a photo place offers Shape “Pen shape”.
- **Renderer:**
  - the photo is cut to the shape, with its border inside it;
  - a pen shape's border is drawn whole, half outside its box;
  - the designer shows the same (CSS clip-path for photos, SVG for shapes).
- **Tests:**
  - **unit:** geometry (curve bounds, back to the canvas), schema, point insert/toggle, and renderer pixels (photo inside the triangle, background outside, a 40 px border above an 8 px-tall line);
  - **Chromium smoke on a scratch database:**
    - drew a photo slot with one curve: 4 points and 2 handles shown;
    - dragged a point: X and width followed;
    - drew a shape with Enter, checked the Real output from the production renderer, and saved;
    - no console errors;
    - clicked coordinates landed exactly (300, 200, 400 × 400).

**Not verified here:**
- The owner's own photos and post #1367.
- The person model download on the owner's PC: `npm run start:all` installs it; if it fails, crops use faces only.
- How fast detection runs on the owner's PC: here, about 2–3 s per photo for both models.
- Touch or pen-tablet input in the designer (mouse only).

**Commands run**
```
npx tsc --noEmit                    # 0 errors
npx vitest run tests/unit/images.test.ts   # 30/30
npx vitest run --config vitest.integration.config.ts tests/integration/workflow-publish.test.ts   # 8/8
npx vitest run --config vitest.integration.config.ts tests/integration/image-tools.test.ts -t "Regenerate images"   # 1/1
real-photo harness (scratch): 17 Commons photos, real MediaPipe face + person detection, contact sheets checked by eye
Chromium smoke of the pen tool (scratch database, dev server)
npx vitest run                      # 47 files, 342 tests pass (final head)
BAS_TEST_MEDIAPIPE_DIR=<scratch mediapipe> npx vitest run --config vitest.integration.config.ts tests/integration/image-tools.test.ts tests/integration/images.test.ts tests/integration/workflow-publish.test.ts   # 3 files, 26/26 (the real-MediaPipe test ran: not skipped)
next build                          # compiled
```

## Owner request (2026-10-23): the tool as a Windows program (.exe), on its own branch

**Request:**
- “start the .exe work”, on another branch, without ending the Node.js tool;
- it need not use Chrome (“you can build your own browser”);
- the way it works may change, but every feature stays, and it should not take long.

**Branch:** `claude/desktop-app`, on top of `claude/confident-brown-pwlrz6`. The Node.js tool (`npm run start:all`) is unchanged and keeps working.

**What the app is** (`desktop/`, Electron 44.7.0 for the window only):
- **Startup:** one window with the dashboard; the server (`next start`) and the worker run hidden on a bundled Node.js 26.11.1 (Windows build, SHA-256 checked against nodejs.org). The migration and settings steps (preflight, with a backup first) run at every start, and a start-up page shows each step.
- **Data folder:** chosen at the first start, either the one `npm run start:all` uses or a new one. The `.env` next to it is read too. Both cannot run at once: if port 3000 is busy, the app says so and offers Retry.
- **Tray:** closing the window keeps the app there, so the workflow keeps running. The tray offers Open, Automation Chrome, the data folder, the log, Start with Windows, Keep running, Another data folder, and Quit.
- **Quit:** stops the worker over its IPC channel (Windows has no signals for child processes), then the server. A worker change makes this safe: it stops as on Ctrl+C, and also when the app's channel closes.
- **Window security:**
  - sandboxed and context-isolated, with no Node access;
  - only `localhost:3000` is shown; every other address opens in the default browser;
  - no permissions except copying text;
  - the dashboard's own Host, Origin and CSRF checks still apply.
- **Browser for ChatGPT and Search Console:** still Automation Chrome with the extension.
  - An embedded browser would hit Google's block on sign-ins in embedded browsers, and could only pass it by pretending to be Chrome, which this project does not do.
  - Porting the extension would change working features.
  - So every feature stays as it is, as the owner asked.
- **Installer** (`electron-builder` 26.17.0, NSIS):
  - per user, no administrator, desktop and Start-menu shortcuts;
  - the data folder is never inside the installation and never deleted;
  - not code-signed, so SmartScreen may warn.
- **Build:** `.github/workflows/desktop.yml` builds it on `windows-latest` (npm ci, build, typecheck, `desktop/prepare.mjs`, `electron-builder --win nsis`) and uploads the installer as the artifact `Blog-Automation-Studio-Setup`.

**Found while testing:** electron-builder silently leaves `node_modules` out of a folder copied as `extraResources`, so the first packaged app failed at the migration step (`prisma/build/index.js` missing). `node_modules` is now listed as its own resource.

**Tested here (Linux, the same code packaged with `--linux` and `electron-builder --dir`, under Xvfb with Playwright's Electron driver):**
- the start-up page showed, then the dashboard opened 12 s after launch on a new data folder (migrations, settings), with the Overview page and the worker online;
- the worker held its lock while running;
- Quit took under 1 s: the log shows “Worker stopped (desktop app)” and the lock was released.

**Not verified here:**
- **The Windows installer itself:** it is built by the workflow on GitHub's Windows runner. Its first run is the check of the Windows build.
- The app on the owner's PC: SmartScreen, the tray, Start with Windows, the owner's data folder, Automation Chrome launched from it.
- Unit tests on Windows: the workflow runs the typecheck only; tests run on Linux as before.

**Commands run**
```
cd desktop && npm install                      # electron 44.7.0, electron-builder 26.17.0 (allowScripts: electron only)
node desktop/prepare.mjs --linux               # bundle: app 757 MB, runtime 144 MB; SHA-256 checked
npx electron-builder --dir --linux             # desktop/dist/linux-unpacked
xvfb-run node <smoke>                          # start, Overview, worker online, Quit with a safe worker stop

## Owner report (2026-10-23): ChatGPT showed about 6 photos, the article got 2 (extension 3.4.2)
The Images tab listed only `upload:gallery-1` and `upload:gallery-5`, while ChatGPT's gallery showed about six photos (one a broken-picture icon, two the same winter photo, one a collage).

**Cause (reproduced in the fake ChatGPT before the fix):**
- **Viewer read wrongly.** The extension took “the largest picture in the viewer”, measured without looking at where it was.
  - A viewer that slides its pictures side by side keeps the others just beside its window.
  - A viewer that fades keeps them all stacked with opacity 0.
  - In both, every picture counted as fully shown, so the first one won at every step. The loop then stopped after one large picture.
  - Tests with the old adapter: carousel saved 1 of 6 large pictures, fade 1 of 4.
- **Viewer without “Next”.** It gave one large picture (lightbox test: 1 of 5).
- **Thumbnails only.** The rest of the photos were then only the small thumbnails, and the app leaves those out (smaller than 250 px). That fits the numbering: pictures 2–4 were dropped.
- **Regenerate reused thumbnails.** “Regenerate images” reused *every* gallery picture saved before, including those small thumbnails (test: “6 photo(s) collected before”, a 240×135 thumbnail among the photos).

**Fix:**
- **Extension 3.4.2:**
  - `shownPicture` counts only the part of each picture really on screen: inside the window and every clipping parent, times its opacity.
  - When the viewer did not go through all its pictures (no “Next”, or a picture that stopped changing), each gallery photo is opened by itself, as a person would, and its large picture is saved.
  - A viewer that ended by itself (“Next” turned off, or back to the first picture) is not opened again.
  - That pass never clicks a picture that links to another site (it would open a tab), and it stops after two pictures that open no viewer.
  - Large pictures are never left out for a caption word such as “style icon”; the avatar/logo/icon words now apply only to pictures under 120 px.
  - Pictures inside the viewer are not counted as gallery thumbnails.
- **Task log:** the extension reports what it saw, and the task log shows it with the answer. It reads like “Gallery: 6 picture(s) in the gallery (0 not shown by the page), 6 opened large, … saved, … reported as link(s).” (the carousel test).
- **App:**
  - The Images tab notes say how many pictures came in (saved by Automation Chrome / links), how many were skipped as small, and how many as near-duplicates of a larger copy. These notes come before the notes about each link.
  - Regenerate reuses only earlier gallery photos of at least 250 px on both sides.

**Tests:**
- **Extension integration (fake ChatGPT):** new viewers `carousel` (6), `fade` (4) and `lightbox` (5). Each saves every large picture, all different, and the task log carries the report. The earlier gallery tests (4 + link opens the viewer once, “+10”, broken pictures) still pass.
- **Integration:**
  - The ChatGPT image-search pipeline test checks the new “4 gallery picture(s) received (3 saved by Automation Chrome, 1 link(s))” note.
  - The regenerate test has a thumbnail in the first search, and it is not reused (5 photos, not 6).

**Not verified here:**
- The real ChatGPT viewer. Its markup was not available, so the fix covers the three viewer kinds above.
- After the owner updates and reloads the extension (3.4.2), the next image search's task log line shows what the real page gave.
- Two tiles of the same photo still count once, and another site's collage is still kept out of the body images by the photo check. This is unchanged and intended.

**Commands run**
```
npx vitest run --config vitest.integration.config.ts tests/integration/extension.test.ts -t "viewer: the large picture"   # before: carousel 1/6, lightbox 1/5 (fail); after: 3/3
old adapter.js with the new tests: carousel 1 of 6, fade 1 of 4 (fail), restored
npx vitest run --config vitest.integration.config.ts tests/integration/image-tools.test.ts -t "Regenerate images"   # before: “6 photo(s) collected before” (fail); after: pass
npx tsc --noEmit                    # 0 errors
npx vitest run                      # 47 files, 342 tests pass
npx vitest run --config vitest.integration.config.ts tests/integration/image-tools.test.ts tests/integration/images.test.ts   # 17 passed, 1 skipped (real MediaPipe, no BAS_TEST_MEDIAPIPE_DIR)
npx vitest run --config vitest.integration.config.ts tests/integration/extension.test.ts   # 43/43
(after the last change: the link/no-viewer guard) the 6 gallery tests of extension.test.ts   # 6/6; npx tsc --noEmit   # 0 errors
next build                          # compiled (final head)
```
Merged into `claude/desktop-app` as well (typecheck 0 errors there), so the Windows installer carries it.
