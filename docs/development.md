# Running from source (npm) and development

The desktop app ([README](../README.md)) is the normal way to use Blog Automation Studio. This page is for running the same tool from the source code with Node.js and npm (the `claude/npm-version` branch keeps an npm-only copy), and for developing it. The tool's behaviour is described in the [user guide](user-guide.md).

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

Find any page with the **search box** in the top bar (Ctrl+K or “/”): pages appear as you type, ↑/↓ and Enter open one, and “Articles: …” searches your articles. The **bell** next to it lists what needs you (worker, extension, WordPress sign-ins). The button left of the search folds the menu to icons (remembered); the menu's groups (Articles, Websites, …) fold with their arrow. Long lists — Article Queue, Article History and the workflow keyword queue — come in pages (“Results per page”, “Page 1 of N”), and **Settings** shows one group at a time, picked on the left (a dot marks a group with unsaved changes).

```powershell
npm run dev:all        # development: dashboard + worker (auto-reload)
# or, for daily use:
npm run build
npm run start:all      # production build: dashboard + worker
```

Open **http://localhost:3000**. Only one worker can own the `data\` folder; a second one refuses to start.

`npm run start:all` and `npm run dev:all` first run the safe steps of `npm run setup` by themselves (data folders, `.env` when missing, migrations with a backup, missing settings). `start:all` also builds the dashboard when there is no build yet or the code changed since the last one. So on a new computer `npm install` then `npm run start:all` is enough; a database is never reset.

## First run (npm copy)

1. **Automation Chrome** (sidebar): follow the five checked steps — start the dedicated Chrome window, load the unpacked extension from the `extension\` folder, paste the one-time connection key, sign in to ChatGPT yourself. “Send test prompt” proves the round trip.
   After setup you do not need to keep it open: when you queue an article, or a Search Console indexing request is due, the worker opens Automation Chrome by itself, and closes it again (normally, never forced) 2 minutes after the queue is done. When Chrome still runs in the background with its windows closed, a window is opened in it for the waiting work. A Chrome window you opened yourself is never closed. Both switches are in **Settings → Browser**; when Chrome was not opened, **Logs** says why once.
2. **Websites → Add website**: the address (the name is filled in from it), language, country and time zone, and the WordPress **user name and password**. **Add and log in**: the app signs in by itself (with “Remember me”) and syncs the categories; pick a default category on the Settings tab. If WordPress shows a CAPTCHA or asks for a 2-step code, a window opens with the user name and password filled in and you do that step. Without a saved sign-in, **Log in yourself** on the Session tab opens the window for the whole sign-in.
3. **Single Article**: enter a keyword and generate. The finished article is saved as a **WordPress draft** and read back to verify it.
4. Optional: **Bulk Campaigns**, **Workflow / Calendar**, **Image Template**, **Settings**.

## Updating the npm copy

**You are told when there is a new version:** the worker looks at GitHub every hour (and right after it starts). When your branch has new changes, a Windows notification “App update available” appears once per new version, and the bell (and the banner) shows “App update available” with an **Update** link to Settings → App updates until you update. Nothing is installed by itself. Turn the Windows notification off in Settings → Notifications → “A new app version is available”; the bell still shows it.

**With one click (Settings → App updates):** **Check for updates** asks GitHub (`git fetch`) what is new on your branch and lists the changes, with a note when new packages, database changes or a new extension come with them. **Update now** then stops the dashboard and the worker, brings the code to exactly the version shown (`git merge --ff-only`), runs `npm install` only when the packages changed, builds, runs the migrations (backup first) and starts both again. The page shows each step — while the dashboard is stopped, the same address shows a small “updating” page — and opens the new version by itself (usually 2–5 minutes). If installing or building fails, the code goes back to the version you had and that one starts again; the card says so and “Show steps” has the details. Articles, settings, websites and sign-ins are never touched.

- It works when the app was started with `npm run start:all` (that window stays open and does the update). With `dev:all`, update in a terminal as below.
- It does not start when files of the project were changed on this computer (it would overwrite them) or when this computer has commits GitHub does not have; the card says which.
- Steps running at that moment stop and continue after the restart, as when you close the window yourself.
- A change to `scripts\start-all.mjs` itself takes effect the next time you start the window.
- **The extension (3.5.0 and later) reloads itself** from the `extension\` folder after an update, when it is idle, and reloads its ChatGPT tab. This needs the extension loaded with chrome://extensions → **Load unpacked** (as in First run). An extension older than 3.5.0 needs one reload by hand.

**In a terminal:**

```powershell
# stop npm run dev:all / start:all first
git pull
npm install
npm run start:all      # migrates (with backup), seeds and rebuilds by itself when needed
```

`npm run setup` and `npm run build` still work on their own, for example to see each step.

Then reload the extension in Automation Chrome (`chrome://extensions` → reload) if it is older than 3.5.0; the Automation Chrome page shows when the version does not match.

## Troubleshooting the npm copy (Windows)

| Symptom | What to do |
| --- | --- |
| `npm` scripts refuse to run (“running scripts is disabled”) | Run once in PowerShell: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `Port 3000 is already in use` | Another dashboard is running: close it, or find it with `netstat -ano \| findstr :3000` |
| “Another worker owns the data folder” | Only one worker may run. Close the other window; a crashed worker's lock is taken over automatically once its PID is gone |
| Chrome not found | Install Google Chrome, or set `BROWSER_CHANNEL="msedge"` (Edge) or `BROWSER_EXECUTABLE_PATH` in `.env` |
| WordPress keeps asking to log in | Log in again with “Remember Me” ticked; security plugins that end sessions on browser close need that option |
| Files in `data\` are locked / “EBUSY” | Exclude the project folder from real-time antivirus scanning, and stop the app before restoring a backup |
| The extension shows “disconnected” | Open Automation Chrome; check the key on the Automation Chrome page; **Logs / Diagnostics → Checks** runs the setup check and a test prompt |
| An update stopped half-way (e.g. the disk was full): `git pull` says “Your local changes … would be overwritten”, or the build says “Parameter … implicitly has an 'any' type” | Free at least 2 GB on the drive. Then, in the app folder: `git stash push --include-untracked -m "half update"`, `git pull`, `npm run start:all`. The stash only holds the half-copied files (your data in `data\` and `.env` are not touched); `git stash drop` removes it later. Since this version `npm run start:all` updates the Prisma client by itself when the schema changed, and Settings → App updates does not start an update with less than 1.5 GB free |
| Something else | **Logs / Diagnostics → Download diagnostic bundle** (cookies, keys, tokens and passwords are stripped) |
| Fewer gallery photos than ChatGPT showed, or Search Console's answer missing from the screenshot | **Logs / Diagnostics → Page structure copies**: the extension (3.5.0+) saved the page's structure there — elements, button names, sizes, never the chat or page text (`data\page-copies`, newest 40). Download the newest and send it to the developer; the task log names the file |

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
| `npm run audit:a11y` | Accessibility audit (axe-core, WCAG 2.1 AA, light and dark) of the running dashboard |

### Testing against a disposable WordPress

Only ever point this at a throw-away site — it creates drafts and deliberately tries (and must fail) to publish them.

```powershell
$env:WP_E2E_ADMIN_URL = "http://localhost:8080/wp-admin/"
$env:WP_E2E_USER = "admin"            # credentials of the DISPOSABLE site only
$env:WP_E2E_PASSWORD = "..."
npm run test:e2e:wordpress
```

The test types these credentials itself (simulating you in the login window); the app never stores them.

## Building the desktop app

In the repository root run `npm ci` and, in PowerShell, `$env:BAS_STANDALONE=1; npm run build` (Next.js then also writes its standalone server, which the app carries). In `desktop\` run `npm ci`. Back in the root run `node desktop/prepare.mjs` and `node desktop/check-bundle.mjs`, which runs a copy of the bundle outside the repository, as the installed app does. Then in `desktop\` run `npm run dist:win`. The installer is written to `desktop\dist`. The GitHub workflow also runs the ChatGPT tab against a fake ChatGPT page (`tests/integration/desktop-chatgpt.test.ts`), installs the app and starts it once (`--smoke-test`, which also checks that the ChatGPT tab reaches the dashboard).

## Backup & restore (command line)

```powershell
npm run db:backup -- --media
# stop npm run dev:all first
npm run db:restore -- 2026-10-14T12-00-00-000Z-manual
npm run db:migrate
```

Backups use SQLite `VACUUM INTO`, so they are consistent even while the worker runs. Browser profile folders are never included.

## Security notes (technical)

- The dashboard has no accounts by design (owner request). Do not expose port 3000 to a network; it binds to `127.0.0.1`.
- The ChatGPT extension authenticates with a one-time-displayed connection key (`bas_…`); only its hash is stored.
- Logs and the diagnostic bundle redact cookies, tokens, keys and passwords.
- Saved WordPress sign-ins (owner request: automatic login) are encrypted with AES-256-GCM in `data\credentials\wordpress-logins.json`, with a random key next to it (`wordpress-logins.key`); each entry is bound to its website. That protects against a copied database, log or screenshot, not against someone with the whole data folder (which holds the signed-in browser profiles anyway). The dashboard never gets a password back — only the user name and how the last automatic login went. The password is typed only into the website's own login page (same host as its admin address); a refused password is not tried again until you change it, so security plugins do not lock the account; CAPTCHAs and 2-step codes are always left to you. Remove a sign-in on the website's Session tab.
- Every outside page the app reads (link checks, images, plagiarism sources) goes through one SSRF-safe fetcher: public addresses only (checked again on every redirect), size and time limits, no cookies.
- Article HTML is allow-listed before it is saved and again before it is shown, including unsaved edits in the editor.
- Optional `SERPER_API_KEY` (plagiarism web search) stays in `.env`; it is sent only to that API and never logged or shown.
