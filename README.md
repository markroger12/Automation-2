# Blog Automation Studio 3.0

A private, **Windows-first, local** dashboard for a publisher running several English and German WordPress websites. You submit keywords; the app prepares research-led SEO articles through **your own signed-in ChatGPT website session** (a Chrome extension, not the OpenAI API), checks and improves them, and saves **WordPress drafts** with Rank Math fields filled.

- Runs only on your computer: Next.js dashboard + one Node worker + SQLite (`data/app.db`). No Docker, no cloud database, no telemetry.
- **No login screen** — it is a single-owner tool. The dashboard listens on `127.0.0.1` only, and every state-changing request needs a same-origin CSRF token, so neither other computers nor other websites can drive it.
- **Draft-only by default.** Publishing/scheduling requires a per-site `canPublish` switch *and* the scheduler path.
- WordPress passwords are never asked for, typed or stored: you log in once per site in a visible browser window.

> Build progress, verified commands and known limitations are tracked in [BUILD_STATUS.md](BUILD_STATUS.md).

## Requirements

- **Node.js 26 or newer** (latest release). Check with `node --version`.
- **Google Chrome** (Microsoft Edge works as a fallback for WordPress automation).
- Windows 10/11 (macOS/Linux also work for development).

## Install (PowerShell)

```powershell
cd "C:\path\to\Automation-2"
npm install
npm run setup
```

`npm run setup` is idempotent — run it again after every update:

1. checks the Node version and creates `data\` folders,
2. creates `.env` from `.env.example` **only if `.env` does not exist**,
3. backs up the database when migrations are pending, then applies them (never resets data),
4. seeds missing settings and default prompts (your edited prompts are never overwritten),
5. checks that Chrome/Edge is installed and prints next steps.

## Run

```powershell
npm run dev:all        # development: dashboard + worker (auto-reload)
# or, for daily use:
npm run build
npm run start:all      # production build: dashboard + worker
```

Open **http://localhost:3000**. Only one worker can own the `data\` folder; a second one refuses to start.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run setup` | Idempotent setup/upgrade (see above) |
| `npm run dev` / `npm run worker:dev` / `npm run dev:all` | Dashboard, worker, or both in development |
| `npm run build` / `npm run start:all` | Production build and start |
| `npm run db:migrate` | Back up, then apply pending migrations (`prisma migrate deploy`) |
| `npm run db:seed` | Insert missing defaults only |
| `npm run db:studio` | Browse the SQLite database |
| `npm run db:backup -- --media` | Consistent backup to `data\backups\` |
| `npm run db:restore -- <folder>` | Restore a backup (stop the app first; current DB is moved aside) |
| `npm run typecheck` / `npm test` / `npm run test:integration` | Quality gates |
| `npm run test:e2e:wordpress` | Optional: draft/publish-guard tests against a **disposable** WordPress (see below) |

### Testing against a disposable WordPress

Only ever point this at a throw-away site — it creates drafts and deliberately tries (and must fail) to publish them.

```powershell
$env:WP_E2E_ADMIN_URL = "http://localhost:8080/wp-admin/"
$env:WP_E2E_USER = "admin"            # credentials of the DISPOSABLE site only
$env:WP_E2E_PASSWORD = "..."
npm run test:e2e:wordpress
```

The test types these credentials itself (simulating you in the login window); the app never stores them.

## Images

- **Image Template** (sidebar) — a per-website designer on a true 1920×1080 canvas for the featured image and, optionally, body images. Drag/resize/rotate, layers, undo/redo (Ctrl+Z / Ctrl+Shift+Z), snapping (hold Alt to bypass), arrow-key nudge, zoom/fit, presets (single photo with corner logo, split photo with centre logo), logo upload (PNG/JPEG/WebP or SVG, which is sanitized and rasterized), fixed photos, accent colour, and Polotno-style JSON import (image URLs are never fetched; nothing in the file is executed). The live preview is drawn by the same renderer the article pipeline uses; **Check final size** shows the real output size against your byte budget (Settings → SEO).
- **Article → Images tab** — rendered images with alt text, the photos that were collected, your own uploads (used before anything searched or generated) and “Don’t use” for any source photo. **Regenerate images** re-renders and updates the same WordPress draft.
- Celebrity articles collect a bounded photo gallery from Wikimedia Commons (12 MB cap, private hosts blocked, exact and near-duplicates removed); general articles ask ChatGPT for an image plan and three images through the extension. Missing images never block the text: the draft continues without them, or waits for review if the site requires images. No image-rights or licensing checks are performed (owner decision); the source URL is stored for reference only.
- After updating, reload the extension in Automation Chrome (version 3.1.0 adds image capture).

## Data folder (`data\`, git-ignored)

| Path | Contents |
| --- | --- |
| `app.db` | SQLite database (WAL mode) |
| `profiles\<site>` | Per-site WordPress browser profiles — **treat like passwords** |
| `chatgpt-chrome\` | The dedicated Automation Chrome profile for ChatGPT |
| `media\`, `screenshots\`, `logs\` | Generated images, failure screenshots, logs |
| `backups\` | Database (+ optional media) backups |
| `worker.lock` | Single-worker ownership lock (PID + heartbeat) |

## Backup & restore

```powershell
npm run db:backup -- --media
# stop npm run dev:all first
npm run db:restore -- 2026-10-14T12-00-00-000Z-manual
npm run db:migrate
```

Backups use SQLite `VACUUM INTO`, so they are consistent even while the worker runs. Browser profile folders are never included.

## Security notes

- The dashboard has no accounts by design (owner request). Do not expose port 3000 to a network; it binds to `127.0.0.1`.
- The ChatGPT extension authenticates with a one-time-displayed connection key (`bas_…`); only its hash is stored.
- Logs and the diagnostic bundle redact cookies, tokens, keys and passwords.
