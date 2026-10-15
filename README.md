# Blog Automation Studio 3.0

A private, **Windows-first, local** dashboard for a publisher running several English and German WordPress websites. You submit keywords; the app prepares research-led SEO articles through **your own signed-in ChatGPT website session** (a Chrome extension, not the OpenAI API), checks and improves them, and saves **WordPress drafts** with Rank Math fields filled.

- Runs only on your computer: Next.js dashboard + one Node worker + SQLite (`data/app.db`). No Docker, no cloud database, no telemetry.
- **No login screen** — it is a single-owner tool. The dashboard listens on `127.0.0.1` only, and every state-changing request needs a same-origin CSRF token, so neither other computers nor other websites can drive it.
- **Draft-only by default.** Publishing/scheduling requires a per-site `canPublish` switch *and* the scheduler path.
- WordPress passwords are never asked for, typed or stored: you log in once per site in a visible browser window.

> Build progress, verified commands and known limitations are tracked in [BUILD_STATUS.md](BUILD_STATUS.md); the release steps are in [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).

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

## First run

1. **Automation Chrome** (sidebar): follow the five checked steps — start the dedicated Chrome window, load the unpacked extension from the `extension\` folder, paste the one-time connection key, sign in to ChatGPT yourself. “Send test prompt” proves the round trip.
2. **Websites → Add website**: public URL, language, country and time zone. Then **Log in** opens a visible window where *you* sign in to WordPress (leave “Remember Me” ticked, or the sign-in ends when the window closes). **Sync categories** and pick a default category.
3. **Single Article**: enter a keyword and generate. The finished article is saved as a **WordPress draft** and read back to verify it.
4. Optional: **Bulk Campaigns**, **Workflow / Calendar**, **Image Template**, **Settings**.

## Updating

```powershell
# stop npm run dev:all / start:all first
git pull
npm install
npm run setup          # backs up and migrates the database; never deletes your data
npm run build          # only if you use start:all
```

Then reload the extension in Automation Chrome (`chrome://extensions` → reload) if the release notes mention a new extension version; the Automation Chrome page shows when the version does not match.

## Troubleshooting (Windows)

| Symptom | What to do |
| --- | --- |
| `npm` scripts refuse to run (“running scripts is disabled”) | Run once in PowerShell: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `Port 3000 is already in use` | Another dashboard is running: close it, or find it with `netstat -ano \| findstr :3000` |
| “Another worker owns the data folder” | Only one worker may run. Close the other window; a crashed worker's lock is taken over automatically once its PID is gone |
| Chrome not found | Install Google Chrome, or set `BROWSER_CHANNEL="msedge"` (Edge) or `BROWSER_EXECUTABLE_PATH` in `.env` |
| WordPress keeps asking to log in | Log in again with “Remember Me” ticked; security plugins that end sessions on browser close need that option |
| Files in `data\` are locked / “EBUSY” | Exclude the project folder from real-time antivirus scanning, and stop the app before restoring a backup |
| The extension shows “disconnected” | Open Automation Chrome; check the key on the Automation Chrome page; **Logs / Diagnostics → Checks** runs the setup check and a test prompt |
| Something else | **Logs / Diagnostics → Download diagnostic bundle** (cookies, keys, tokens and passwords are stripped) |

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

## Images

- **Image Template** (sidebar) — a per-website designer on a true 1920×1080 canvas for the featured image and, optionally, body images. Drag/resize/rotate, layers, undo/redo (Ctrl+Z / Ctrl+Shift+Z), snapping (hold Alt to bypass), arrow-key nudge, zoom/fit, presets (single photo with corner logo, split photo with centre logo), logo upload (PNG/JPEG/WebP or SVG, which is sanitized and rasterized), fixed photos, accent colour, and Polotno-style JSON import (image URLs are never fetched; nothing in the file is executed). The live preview is drawn by the same renderer the article pipeline uses; **Check final size** shows the real output size against your byte budget (Settings → SEO).
- **Article → Images tab** — rendered images with alt text, the photos that were collected, your own uploads (used before anything searched or generated) and “Don’t use” for any source photo. **Regenerate images** re-renders and updates the same WordPress draft.
- Celebrity articles collect a bounded photo gallery from Wikimedia Commons (12 MB cap, private hosts blocked, exact and near-duplicates removed); general articles ask ChatGPT for an image plan and three images through the extension. Missing images never block the text: the draft continues without them, or waits for review if the site requires images. No image-rights or licensing checks are performed (owner decision); the source URL is stored for reference only.
- After updating, reload the extension in Automation Chrome (version 3.1.0 adds image capture; 3.1.1 waits for a reloaded conversation to render before looking for an already-sent prompt).
- **Alt text** is checked for every rendered image:
  - “Image of …” is dropped and long text is shortened to 125 characters;
  - file names, web addresses, one-word labels, keyword stuffing and the same text on two images are replaced with a neutral text (the article title for the featured image, “*Subject*: article image 2/3” for body images);
  - every change is listed in the image notes. Alt text you edit in the article wins.
- **Uploads happen once.** Each image is uploaded under a unique name, so if an upload's answer is lost (timeout), the next attempt finds it in the Media Library instead of uploading it again. An image that cannot be uploaded is left out of the draft with a note; the text is still saved.

## WordPress health

On each website page, **Site health** shows only measured results, kept for 30 days:
- session tests;
- whether the REST API answers the logged-in account;
- the account's permissions (create posts, upload images, create tags);
- the detected editor and Rank Math;
- every draft save (with duration) and media upload.

The overall status is *healthy*, *needs attention*, *failing* or *no data yet*, with the reasons. **Test session** runs the checks again.

- **Articles stopped at a WordPress step** (draft save, Rank Math, verification) are listed there. **Re-save selected** gives each one “Save to WordPress again”:
  - the stored draft is reopened, never duplicated;
  - a draft edited in WordPress still stops for your decision;
  - it is refused while the site is paused or logged out.
- **Edited in WordPress?** The article's WordPress tab shows **Changes made in WordPress**: the text only in the WordPress version (what an overwrite would replace) next to the text only in the app version. Read it before choosing “Overwrite WordPress draft”.
- WordPress's own “session expired” pop-up counts as logged out. An account that may not write posts stops with that reason instead of a generic error.

## Editorial tools

- **Humanizer** (Editorial Tools → Humanizer): edits a saved article or pasted text paragraph by paragraph, in batches of about 1,200 words, through your ChatGPT session. Each rewrite is checked against **fact locks**: numbers, dates, quotations, names, links, bold/italic text, the keyword count, the language, a single paragraph, hedging such as “reportedly”, and length (±20 % by default). Any violation keeps the original paragraph and records the reason. Results show side by side with editorial diagnostics (empty phrases, repeated openers, sentence rhythm). It does **not** compute an “AI detection” score. A result reaches an article only when you click **Apply**, and the WordPress draft changes only when you re-save it.
- The same humanizer runs inside every article as the HUMANIZE stage, always starting from the unedited text. Settings → Content controls whether it is on, which paragraphs it edits (all or only flagged ones), the batch size and the length tolerance.
- **Plagiarism Evidence** (Editorial Tools → Plagiarism Evidence, or an article's **Originality** tab): compares a saved article or pasted text with your other saved articles (all websites), the pages it links to (up to 10), up to 10 URLs you add, Wikipedia extracts for the topic and — only if you put a `SERPER_API_KEY` for the licensed Serper search API in `.env` — web pages found for a few distinctive passages. It shows **identical runs of 8+ words** (verified word for word in the source) and **closely matching sentences** side by side with their source, plus a coverage list of everything that was or could not be compared. Quotations and text that recurs across your own site are not counted. There is no plagiarism score: read the evidence and decide. Search engine pages are never scraped; without a key, everything else still works.
- **Celebrity Writer 2.0 is retired.** Old 2.0 articles stay readable (outputs, post IDs, logs, prompts) but can't be run, queued or edited. If a backup is ever needed, the retirement migration's changes can be undone with `npm run db:rollback-retirement -- <backup-file>` from `data\backups\migrations\`.

## Campaigns and workflow

- **Bulk Campaigns** (sidebar → Bulk Campaigns → New): paste keywords (one per line, `keyword | secondary1, secondary2 | example title`, CSV or tab-separated columns from a spreadsheet; up to 1,000 rows) or load a file. The preview checks every row before anything is created: the writer (the Smart Router picks Celebrity or Tigram and asks you when unsure), website and category, exact and near duplicates, existing tasks and already-published posts. Fix rows in the preview, then create; one article is queued per ready row and nothing is ever duplicated, even after a restart. Pause, resume, cancel, per-row retry/corrections and CSV export are on the campaign page. **Campaigns never publish.**
- **Workflow** (sidebar → Workflow): a keyword queue per website. Set publishing slots as `h:mm AM/PM` in **Pakistan time** (Asia/Karachi; daylight-saving-safe for the website's own clock), optional weekdays, how many hours ahead to start writing and how many articles may wait at once. Each keyword gets its own slot (two articles never share one); an article that is not ready by its slot moves to the next free slot, and stops after the retry limit with the reason.
- **Publishing stays off** until you switch it on for a website and type the acknowledgement (Websites → the website → Publishing permission). Without it, workflow articles stay **verified drafts**; once their slot passes they are marked “draft kept (publish yourself)”. With it, the verified draft is **scheduled** in WordPress for its slot (never published early), read back to confirm, and checked again after the slot. A post you trash or change in WordPress is left alone.
- **Indexing**: the tool never claims a post is indexed. With “Remind me to request indexing” on, a Search Console link appears after publishing; you mark “indexing requested” and “indexed” yourself after checking.
- **Publishing Calendar** (sidebar, under Workflow): reserved and free slots of every workflow, two weeks at a time, in Pakistan time.

## Search Performance and Content Refresh

- **Search Performance** (sidebar → Productivity → Search Performance) shows only data you export from Google Search Console:
  1. In Search Console open **Performance → Search results**, choose the date range (optionally **Compare**), then **Export → Download CSV**.
  2. Upload the zip, or its CSV files.

  What you see:
  - The website needs its Search Console property first (website page → Settings, e.g. `sc-domain:example.com`). Until then the page says **NOT CONNECTED**; with a property but no import it says **NO VERIFIED DATA**.
  - Imports are checked: pages of another property, a search type other than Web, a missing period (no Dates.csv and no dates entered) and the same export twice are refused.
  - The page shows 7/28/90-day totals with how many days have data, and the change only when both periods are complete. Days are Search Console days (Pacific Time), as exported.
  - It also shows top pages and queries (linked to your articles), declining pages (from a Compare export or an earlier report of the same length), and published articles without impressions. Pages missing from a 1,000-row export are not counted.
  - **Indexing**: requests are counted separately from indexing you confirmed yourself and from pages actually seen in search (impressions).
  - Every table exports to CSV; an import can be removed.
- **Content Refresh** (Editorial Tools → Content Refresh) lists verified articles that need a refresh, with the evidence:
  - when an article is listed:
    - a past year in the title or a heading, or “as of 2024” / “Stand: 2024” in the text (ordinary dates such as birth years never count);
    - a dead link (HTTP 404/410; a missing domain only when other links answered, so a dropped internet connection is not mistaken for dead links);
    - a high-impact fact a source now contradicts (Research Evidence);
    - falling clicks or no impressions in imported Search Console data.

    Age alone never lists an article; it only raises the priority.
  - when it runs: each website is evaluated once a day (read-only); **Evaluate now** runs it for one website.
  - **Propose a revision** starts from the article's current text: dead links are removed (their words stay) and the passages to update are named. Edit the HTML, save, then **Approve**.
  - The worker updates the **same WordPress post**:
    - only its content is sent; status, date, slug and URL stay, and the read-back confirms it;
    - drafts are updated directly;
    - a live post needs **Allow approved updates to live posts** on the website's Publishing permission card, and you must type `UPDATE LIVE POST`;
    - if the post was edited in WordPress since the app saved it, nothing is changed (**conflict**). **Start from the WordPress version** makes that text the article's text and proposes again.
  - The article in the app changes only after WordPress confirmed the update. **Roll back** proposes the previous text through the same approval.

## Productivity, websites and recovery

- **Productivity** (sidebar) counts only verified drafts: an article counts once, when its WordPress draft was read back and verified. The post ID is kept as proof, and retries never count twice. The page shows:
  - the last 15/60/120 minutes;
  - the 14-day trend (Pakistan days);
  - totals by website, writer and campaign;
  - the slowest stages (p50/p90, retries, failures);
  - ChatGPT limits and time in backoff;
  - review and paused articles, quality-gate results, and the top reasons articles stopped;
  - alerts (worker stopped, queue stall, high error rate, ChatGPT backoff);
  - CSV exports.

  **Target vs actual** checks the last two consecutive hours against 6 verified drafts each:
  - **PASS** or **FAIL**;
  - **claim suspended** when ChatGPT limits, logins/checks or a stopped worker interfered;
  - **no work to measure** when nothing was queued.

  The capacity figure is an estimate from measured medians and is labelled as one.
- **2-hour benchmark**: run your live test with real ChatGPT and WordPress sessions, then `npm run benchmark:report -- <start time, e.g. 2026-10-15T09:00:00Z>`. It prints and saves (in `data\reports\`):
  - the verified articles of each hour with their WordPress posts;
  - stage timings and retries;
  - stopped articles and versions;
  - the PASS / FAIL / suspended verdict.

  It starts no work.
- **Website Control** (sidebar, under Websites) shows every website with:
  - its language, time zone, session, measured health and categories;
  - its editor, internal-link line, image template, prompt overrides, writer rules and Rank Math setting;
  - its workflow, Search Console property, publishing permission and article counts.

  Actions:
  - **Pause/Resume**, **Priority** and **Max in progress** (0 = no limit) per site; audited.
  - **Check all sessions** queues one session test per site.
  - **Copy safe settings** copies overrides, writer rules, the Rank Math target, the image design (without the source's logo and fixed photos), and — only between sites of the same language — the internal-link line and prompt overrides. URLs, profiles, categories, publishing permission and the Search Console property are never copied.
- **Recovery Center**: open incidents can be resumed from their saved checkpoint or retried. Articles running with no update for 30+ minutes have **Resume from <stage>** (finished stages are not repeated).
- **SEO brief** (article → SEO tab): each article gets a suggested search intent and a brief, which you can edit. It contains the sections to cover, title/meta guidance, the FAQ focus and the keyword guideline.
  - Intents: biography, family/relationship, net worth estimate, explainer, comparison, how-to.
  - The brief is added to the writing prompt (LONG_ARTICLE / ARTICLE). To place it yourself, put `{{seo_brief}}` in the prompt; to turn it off, Settings → SEO → “Add the SEO brief to writing prompts”.
  - An informational check shows which sections the article covers as headings. It never changes the SEO score and never makes the app add text.

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
- Every outside page the app reads (link checks, images, plagiarism sources) goes through one SSRF-safe fetcher: public addresses only (checked again on every redirect), size and time limits, no cookies.
- Article HTML is allow-listed before it is saved and again before it is shown, including unsaved edits in the editor.
- Optional `SERPER_API_KEY` (plagiarism web search) stays in `.env`; it is sent only to that API and never logged or shown.
