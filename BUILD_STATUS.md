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
| M2 Queue and worker | ⏳ next |
| M3 Websites and sessions | ☐ |
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
