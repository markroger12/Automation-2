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
| M3 Websites and sessions | ⏳ next |
| M4 ChatGPT extension vertical slice | ☐ |
| M5 Single Article + content pipeline | ☐ |
| M6 WordPress drafts | ☐ |
| M7 Links and general writer | ☐ |
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
