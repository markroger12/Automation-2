# Blog Automation Studio 3.0

A private, **Windows-first, local** dashboard for a publisher running several English and German WordPress websites. You submit keywords; the app prepares research-led SEO articles through **your own signed-in ChatGPT website session** (a Chrome extension, not the OpenAI API), checks and improves them, and saves **WordPress drafts** with Rank Math fields filled.

- Runs only on your computer: Next.js dashboard + one Node worker + SQLite (`data/app.db`). No Docker, no cloud database, no telemetry.
- **No login screen** — it is a single-owner tool. The dashboard listens on `127.0.0.1` only, and every state-changing request needs a same-origin CSRF token, so neither other computers nor other websites can drive it.
- **Draft-only by default.** Publishing/scheduling requires a per-site `canPublish` switch *and* the scheduler path.
- WordPress sign-in: give the user name and password with the website (or on its Session tab) and the app logs in by itself, and again when the session ends. They are saved encrypted in `data\credentials` only (never in the database, a log, a backup or a report, never shown again) and typed only into the website's own login page. A CAPTCHA or 2-step code is never solved: a window opens for you. Without a saved sign-in you log in yourself in a visible window.

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

Find any page with the **search box** in the top bar (Ctrl+K or “/”): pages appear as you type, ↑/↓ and Enter open one, and “Articles: …” searches your articles. The **bell** next to it lists what needs you (worker, extension, WordPress sign-ins). The button left of the search folds the menu to icons (remembered); the menu's groups (Articles, Websites, …) fold with their arrow. Long lists — Article Queue, Article History and the workflow keyword queue — come in pages (“Results per page”, “Page 1 of N”), and **Settings** shows one group at a time, picked on the left (a dot marks a group with unsaved changes).

```powershell
npm run dev:all        # development: dashboard + worker (auto-reload)
# or, for daily use:
npm run build
npm run start:all      # production build: dashboard + worker
```

Open **http://localhost:3000**. Only one worker can own the `data\` folder; a second one refuses to start.

`npm run start:all` and `npm run dev:all` first run the safe steps of `npm run setup` by themselves (data folders, `.env` when missing, migrations with a backup, missing settings). `start:all` also builds the dashboard when there is no build yet or the code changed since the last one. So on a new computer `npm install` then `npm run start:all` is enough; a database is never reset.

## Desktop app (Windows installer, optional)

The same tool as one Windows program, like Discord: no command window, and nothing else to install (no Node.js, no npm). The Node.js way above keeps working. While `npm run start:all` runs on the same data folder, the app's window just shows it.

- **Install:** download **Blog-Automation-Studio-Setup-….exe** from the repository's *Releases* page (the newest release). Every run of GitHub Actions' “Desktop app (Windows installer)” also has it under *Artifacts*. Run it: it installs with one click for your Windows user only (no administrator), adds a desktop and a Start-menu shortcut, and starts the app. The installer is not code-signed, so Windows SmartScreen may say “unknown publisher”: *More info* → *Run anyway*.
- **First start:** the app asks for the **data folder**.
  - **Choose my data folder…** uses the one `npm run start:all` uses (for example `F:\claude\Automation-2\data`), with the same websites, articles, settings and Automation Chrome profile.
  - **Start with a new data folder** creates an empty one in the app's own folder.
  - A `.env` next to that data folder (e.g. with `SERPER_API_KEY`) is read too.
- **Daily use:** the tab bar at the top has **Dashboard**, **ChatGPT** and **Search Console** (and **Chrome**, the Automation Chrome page). The server and the worker run hidden, on the app's own built-in Node.js.
  - The bar has the tool's own look (the same greys, buttons and Segoe UI font as the dashboard) and follows the dashboard's light/dark switch.
  - On the right, two small status chips say what ChatGPT and Search Console are doing (a green, amber or red dot; hover for the whole text), then the app's version.
  - While the app starts, a card shows the three steps (data, dashboard, worker) and what each one is doing.
- **Like other Windows programs:**
  - **Ctrl+1 / Ctrl+2 / Ctrl+3** switch to Dashboard, ChatGPT and Search Console; **Ctrl+K** in the dashboard opens the search with quick actions (New article, Add a website, New bulk campaign …).
  - Right-click gives Cut, Copy, Paste and a link's address; **Ctrl+R** or **F5** reloads the page shown, **Ctrl+= / Ctrl+- / Ctrl+0** zoom it.
  - The window opens where it was, at the same size (maximized if it was).
  - Press **Alt** for the menus: *File* (tabs, Settings, the data folder, Quit), *Edit*, *View* (reload, zoom, full screen), *Help* (Check for updates, What's new, Keyboard shortcuts, User guide, Troubleshooting with the log and **Copy details for a report**, About).
  - If the dashboard stops answering for a moment (it restarts by itself after a crash), its tab shows **Reconnecting to the dashboard…** and comes back to the same page.
  - After an update, a notification offers what is new in that version.
  - Inside the app, the dashboard's texts name the app and its tabs (no `npm run …` commands), and **Help / Setup** describes the app.
- **ChatGPT inside the app (3.2.0):**
  - Open the **ChatGPT** tab once and sign in to ChatGPT with your **email and password**. The sign-in stays in the app, apart from Chrome; “Continue with Google” does not work there, because Google refuses sign-ins in a browser built into an app.
  - The prompts then run in that tab, with the same ChatGPT scripts as the extension, and the dashboard tab keeps working meanwhile. The dot and the text at the top say whether ChatGPT is ready, needs your sign-in or a check, or is working.
  - **Several prompts at once** (as in Chrome):
    - When more prompts wait, the app opens more ChatGPT tabs, up to **Settings → ChatGPT tabs** (1–5, default 3) and the article slots of High-Throughput mode. It opens one at a time, and only while ChatGPT is signed in without a check.
    - Each tab runs its own prompt. All share your one sign-in.
    - The **ChatGPT** tab shows them side by side: 2 or 3 in columns, 4 or 5 in two rows. ChatGPT draws pictures only in a page that is shown.
    - An extra tab with nothing to do closes after 5 minutes; one closes at once when you lower the setting.
    - The top line says e.g. “working on 2 prompts at once (3 tabs)”.
  - A sign-in page or a human check is never automated: the app shows the ChatGPT tab and a notification, and the job waits for you as in Chrome. Links in answers open in your default browser.
  - While the app's ChatGPT is connected, Automation Chrome's extension (3.4.6) opens no ChatGPT tab and takes no prompt (badge “APP”).
  - **Switching back:** if ChatGPT does not work in the app, untick **App → Run ChatGPT prompts in this app**, and Automation Chrome takes the prompts again.
  - While `npm run start:all` runs and the window only shows it, the prompts stay with Automation Chrome.
- **Search Console in the app (indexing requests):**
  - The **Search Console** tab at the top opens Google Search Console inside the app, with its own storage, apart from ChatGPT. Sign in to Google there yourself, once.
  - The app then makes the **Request indexing** requests in that tab, with the same Search Console script as the extension: it opens the property's URL inspection, asks Google to index the article, saves the proof (the page as it stood) and reports Google's answer, as Automation Chrome did. Automation Chrome is then not opened for indexing at all (its extension answers “Search Console runs in the desktop app”).
  - A Google sign-in page or a Google check is never handled by the app: the request stops with “sign in to Google in the Search Console tab” (or waits for you to finish the check there), the app shows the tab and a notification, and the chip at the top turns amber.
  - The app never reads your Google password. The tab stays on Google's pages; other links open in your default browser. It keeps the app's own user agent and is never disguised as Chrome.
  - While `npm run start:all` runs and the window only shows it, the requests stay with Automation Chrome.
- **A stuck ChatGPT tab is freed by itself:** when a ChatGPT tab shows no progress for 3 minutes (no answer text, no picture, no step) and no sign-in or check is waiting for you, the app reloads it once. If it is still stuck 3 minutes later, the tab is freed and reloaded for the next prompt: a prompt that was not sent yet goes back to the queue and runs again by itself; one that may have been sent is held as “uncertain” for you to check (Retry), so it is never sent twice. A tab that stops responding is reloaded after 1 minute.
- **Google and Search Console in Automation Chrome** (Google refuses sign-ins in a browser built into an app, and the app is never disguised as Chrome). Sign in to Google there once: **Google (Chrome)** at the top opens the Automation Chrome page, whose indexing panel has *Sign in to Google in Automation Chrome*. When an indexing request is due, the worker opens Chrome by itself as a **Search Console window** (Chrome's own app window: no tabs or address bar), and closes it again 2 minutes after the requests.
- **No port to manage:** the dashboard starts on the first free port from 3000 to 3010, and the extension (3.4.3) finds it there by itself. When the tool already runs on the same data folder (e.g. `npm run start:all`), the window shows that one instead of starting a second copy. If the app is closed in any way, even by a crash, its server and worker stop too.
- **Closing the window** keeps the app in the tray (by the clock), so the workflow keeps running; the ChatGPT tab keeps working too. The tray menu has:
  - *Open*, *ChatGPT*, *Automation Chrome (Google, Search Console)*;
  - *Open the data folder*, *Open the log*;
  - *Start with Windows*;
  - *Keep running when the window is closed*;
  - *Use another data folder…*;
  - **Quit**, which stops the worker safely, then the server.
- **Updating the app:**
  - The installed app looks for a newer version on this repository's GitHub **Releases** 30 seconds after it starts and then every 6 hours (also *Check for updates* in the App and tray menus). A newer one downloads in the background; the bar at the top shows “Downloading 3.3.N · 40%”, then a **Restart to update** button and a Windows notification.
  - **Restart to update** stops the work safely first (prompts back to the queue, the worker stopped), installs the new version silently and starts it. Your data folder is never touched; uninstalling never deletes it either.
  - Each build of the Windows workflow gets its own version (3.3.*run number*). Every build of `main` that passes its checks (tests, installer installed and started once) is published as a **GitHub release** `v3.3.N` with the installer, so the installed app finds it by itself. A new install: download **Blog-Automation-Studio-Setup-3.3.N.exe** from the repository's *Releases* page.
  - The app updates from version 3.3.N on; an older install (3.2.0) is updated once by running the new installer.
- **Light and quick:**
  - **Installer:** it carries only what runs: no source maps, type declarations, TypeScript sources, read-me, test or example files of the packages. That is about 9,700 files instead of 18,000, so installing and updating take far less time.
  - **Start:** the worker and the start-up steps are compiled in advance, so nothing is compiled at start. The worker is ready in about 0.65 s instead of 1–1.5 s and uses about 150 MB instead of 185–235 MB.
  - **Smaller memory use:** the dashboard server and the worker run with a smaller memory nursery. The dashboard server measured 252 → 223 MB at rest and 319 → 259 MB after showing every page.
  - **Memory saver, every minute:**
    - Search Console's page is put away 10 minutes after it was last used; the Google sign-in stays.
    - The dashboard page is put away while the window has been in the tray for 10 minutes, and comes back at the same page when you open the window.
    - A ChatGPT tab that is not shown, has had nothing to do for 5 minutes and uses over 700 MB loads ChatGPT afresh.
    - The work itself (server, worker, prompts) never stops for it.
- **What is inside:** the built dashboard, the worker, the migrations and settings steps (run at every start, with a backup first), and only the packages those load. Electron 44.7.0 provides the window and, with its built-in Node.js 24.21, runs the tool; the whole test suite passes on that Node.js too. The window's texts are English only.
- **Building it yourself:** in the repository root run `npm ci` and `npm run build`. In `desktop\` run `npm ci`. Back in the root run `node desktop/prepare.mjs` and `node desktop/check-bundle.mjs`, which runs a copy of the bundle outside the repository, as the installed app does. Then in `desktop\` run `npm run dist:win`. The installer is written to `desktop\dist`. The GitHub workflow also runs the ChatGPT tab against a fake ChatGPT page (`tests/integration/desktop-chatgpt.test.ts`), installs the app and starts it once (`--smoke-test`, which also checks that the ChatGPT tab reaches the dashboard).

## First run

1. **Automation Chrome** (sidebar): follow the five checked steps — start the dedicated Chrome window, load the unpacked extension from the `extension\` folder, paste the one-time connection key, sign in to ChatGPT yourself. “Send test prompt” proves the round trip.
   After setup you do not need to keep it open: when you queue an article, or a Search Console indexing request is due, the worker opens Automation Chrome by itself, and closes it again (normally, never forced) 2 minutes after the queue is done. When Chrome still runs in the background with its windows closed, a window is opened in it for the waiting work. A Chrome window you opened yourself is never closed. Both switches are in **Settings → Browser**; when Chrome was not opened, **Logs** says why once.
2. **Websites → Add website**: the address (the name is filled in from it), language, country and time zone, and the WordPress **user name and password**. **Add and log in**: the app signs in by itself (with “Remember me”) and syncs the categories; pick a default category on the Settings tab. If WordPress shows a CAPTCHA or asks for a 2-step code, a window opens with the user name and password filled in and you do that step. Without a saved sign-in, **Log in yourself** on the Session tab opens the window for the whole sign-in.
3. **Single Article**: enter a keyword and generate. The finished article is saved as a **WordPress draft** and read back to verify it.
4. Optional: **Bulk Campaigns**, **Workflow / Calendar**, **Image Template**, **Settings**.

## Windows notifications

**Settings → Notifications** (on by default): Windows itself shows a notification at the bottom right (and keeps it in the notification centre) when
- an article needs review or approval — also one from the workflow (“Workflow: article needs review”); more than 3 at once come as one notification with the count;
- ChatGPT is signed out in Automation Chrome (the articles wait and go on after you sign in);
- a bulk campaign finished;
- a new app version is on GitHub (“App update available”, once per new version; see Updating below).

A click opens the page. The worker shows them while it runs (Windows PowerShell's own notification, nothing is installed and nothing goes to an outside service); what was already waiting when they were turned on is not notified again. **Send a test notification** shows one right away; when it does not appear, Windows Focus assist / Do not disturb may be holding it back.

## Updating

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

## Writers

- **Celebrity Article Writer**: six prompts in one ChatGPT chat (titles, research, long article, final article, FAQs, Quick Bio).
- **Celebrity 2 Article Writer** (owner request): your own celebrity prompt (Prompt Manager → Celebrity 2 → Article).
  - The title step is the Celebrity writer's: with or without a title from you, ChatGPT suggests titles. Your title only guides it.
  - The approved title goes into the prompt, and the post keeps it.
  - One answer gives the whole article: SEO title, meta description, URL slug, introduction, the direct answer (no heading), the **Family Profile** table, the sections with their source links, the conclusion and five FAQs.
  - A table ChatGPT puts into a code block is turned back into a table.
  - Every source link is opened and checked. A link that fails (for example a 404) keeps its text and loses the link.
  - Photos: the Celebrity writer's photo search and your uploads. The article keeps ChatGPT's order: conclusion, then the FAQs.
- **Tigram Article Writer**: general topics, one article prompt.
- **Category:** a celebrity article (Celebrity and Celebrity 2) always goes into the website's **“Celebrity”** category (German websites: **“Prominente”**; “Celebrities” and “Promis” count too). Nothing to choose, and ChatGPT is not asked.
  - Without such a category the article waits with a message: create it in WordPress, then Websites → the website → Sync categories.
  - Tigram articles keep the category you choose, or ChatGPT picks one.
- **Your own writers (Writers → New writer):** build a writer without code.
  1. Give it a name and choose where it starts: Celebrity 2 (its prompt copied), Celebrity, Tigram, an empty person writer, an empty general writer, or a copy of one of your writers.
  2. On its page:
     - **Basics:** about a person (photos of the person, a facts table, family-claim checks) or any topic (generated images).
     - **Title step:** the app's title step, your own title prompt, or none (the example title, else the article's own title).
     - **Article prompt:** buttons insert `{{keyword}}`, `{{selected_title}}`, `{{secondary_keywords}}`, `{{language_variant}}`, `{{word_range}}`, `{{faq_count}}`, `{{table_heading}}` …; a preview shows it with example values; every save keeps the earlier version.
     - **Answer rules:** words, FAQs (exactly or about; 0 = none), conclusion, SEO lines, no lists, and for person writers the facts table (required, optional or none) and its H2 heading.
     - **Category:** always “Celebrity”, always one category by name (with its German name), or chosen per article (else ChatGPT chooses).
     - **Photos & links:** photos, the link check, internal links, the app's SEO brief (off: the prompt is sent as written).
     - **Photo prompts** (with photos on): **the app's** (Tigram's image plan and image prompt, or Celebrity's photo search, as edited in Prompt Manager), or **my own** for this writer only.
       - General writers get an **Image plan** prompt and an **Image generation** prompt.
         - The plan's answer needs the lines `IMAGE 1 PROMPT: …` / `IMAGE 1 ALT: …` for images 1 to 3 (1 is the featured image). A missing line gets the app's default description.
         - The image prompt needs `{{image_brief}}`, that picture's description from the plan.
       - Person writers get a **Photo search** prompt; it needs `{{person_name}}` (or `{{keyword}}`). The photo check stays the app's.
       - Your own prompts start as a copy of the app's. They are checked like the article prompt and keep their versions; you also find them in Prompt Manager under the writer.
       - Duplicate, Export and Import carry them. Back to the app's: the app's prompts are used again, and yours stay saved.
     - **Keywords:** phrases that send a keyword to this writer by themselves; person writers can be offered for person keywords.
     - **Test:** paste one ChatGPT answer to your prompt and see what the article would get (words, FAQs, table rows, SEO lines, sections, the article itself), or why it would be asked again. Nothing is sent to ChatGPT or WordPress.
  3. **Make active** when the checklist on the side is complete: the writer is then offered in Single Article, Workflow, Bulk Campaigns and website routing rules, and runs with the same steps and quality gate as the built-in writers (drafts only unless the website allows publishing).
  - **Back to draft / Archive** hide it again; its articles still finish. A writer no article used can be deleted.
  - **Export / Import** (to keep a backup, or to move your writers to another PC):
    - **Export** on a writer's page downloads that writer as a file (`writer-<name>.json`). **Export all** (Writers → Your writers) downloads all of them (`writers-<date>.json`).
    - The file holds each writer's name, settings and current prompts. It holds no passwords, keys, websites or articles.
    - **Import** (Writers → Your writers) reads a file made with Export and first shows every writer in it. For each one you choose:
      - **Add as a new writer:** it is added as a draft. If its name is already used here, it gets a free name, which you can change.
      - **Update “…”:** used for the same writer here. Its prompt becomes a new version, and the old one stays under Versions. Its settings are replaced by the file's. Its name and status stay.
      - **Skip.**
    - A writer whose settings or prompt would be refused on its page (for example an unknown `{{variable}}`) is shown with the reason and can only be skipped.
    - A tick box makes the writers that were active in the file active here too, each only when its checklist is complete.
- **Choosing the writer:** for a person keyword the app no longer chooses by itself. You choose **Celebrity** or **Celebrity 2**: in Add keywords per line, with **Person keywords** for all of them at once, or with **Writer for all**. Clear general topics still go to Tigram.

## Images

- **Image Template** (sidebar) — a per-website designer on a true 1920×1080 canvas for the featured image and, optionally, body images, with a **Celebrity** and a **Tigram** template set (**Copy from Celebrity / Tigram** copies one into the other). Photo places can be rectangles or **circles with a coloured ring** (*Circle photo slot*, preset *Photo with circle photo*), or any shape you draw with the **pen** (*Pen photo slot*: the photo is cut to it). **Pen shape** (key P) draws your own shapes and lines like Illustrator's pen: click for corner points, click and drag for a curve, click the first point to close (Enter or a double click finishes, Backspace removes the last point, Esc cancels). On a selected pen layer, drag the squares to move points and the round handles to bend curves (Alt: one side only); double-click a point to switch corner ↔ curve, double-click the line to add a point, Alt-click a point to remove it. *Use as photo slot* turns a closed pen shape into a photo place. Tigram's featured picture goes into the Tigram featured design (ChatGPT draws it without text; the design writes the title) unless *Use the featured design for Tigram featured images* is off. Drag/resize/rotate, layers, undo/redo (Ctrl+Z / Ctrl+Shift+Z), snapping (hold Alt to bypass), arrow-key nudge, zoom/fit, presets (single photo with corner logo, split photo with centre logo), logo upload (PNG/JPEG/WebP or SVG, which is sanitized and rasterized), fixed photos, accent colour, and Polotno-style JSON import (image URLs are never fetched; nothing in the file is executed). **Text fonts:**
  - 4 system fonts plus 20 free fonts that ship with the app: Arimo (Helvetica / Arial look), Inter, Roboto, Open Sans, Montserrat, Poppins, Lato, Raleway, Nunito, Oswald, Bebas Neue, Anton, Archivo Black, Barlow Condensed, Playfair Display, Merriweather, Lora, DM Serif Display, Dancing Script and Pacifico.
  - They look the same on every computer: nothing needs installing, because the picture is drawn from the font files in `public/fonts`, each with its license.
  - Helvetica itself is not free to ship; Arimo has the same letter widths.

**Working with the editor:**
  - On wide screens the editor stays in view while you scroll the panels on the right.
  - The selected layer's settings come first; for a text layer, its text and font come first.
  - **Edit / Real output** above the canvas switches to the picture drawn by the same renderer the article pipeline uses.
  - **Check final size** shows the real output size against your byte budget (Settings → SEO).
  - Colours use the app's own colour picker (area, hue bar, hex / R G B, eyedropper in Chrome, swatches including the accent).
  - Workflow slot times use the app's own time picker.
- **Article → Images tab** — rendered images with alt text, the photos that were collected, your own uploads (used before anything searched or generated) and “Don’t use” for any source photo. **Regenerate images** re-renders and updates the same WordPress draft.
  - **Auto / Featured / Body** on every upload and collected photo (owner request):
    - **Featured** puts it in the featured image (a two-photo design takes your featured photos first);
    - **Body** puts it in a body image;
    - **Auto** lets the app choose.
    - Your choice comes before the app's own order and its checks (also for a photo the checks had put last). More photos chosen than places: the extra featured ones go to the body; an extra body one is left out, and the tab says why.
    - The chip on a photo says where it is used (*used: featured*, *used: body 1* …).
    - **General writers** (Tigram and your general writers): a picture ChatGPT made earlier is kept for its place when you choose one; only the other places are drawn again.
    - The choice applies at the next Images run (Regenerate images).
  - **Adding your photos:** **Upload photos**, or drop picture files anywhere on the Images tab, or copy a picture (right-click → *Copy image*) and press **Ctrl+V** on the tab. PNG, JPEG, WebP or GIF, up to 12 MB each, 8 at a time.
  - They are added in the order you add them, and that is their order in the article. A pasted picture is named after the time it was pasted.
  - A picture dragged straight from another web page arrives only as a link. The tab then says to copy the picture and paste it instead.
- Celebrity articles collect a bounded photo gallery, as in the earlier tool. Your own uploads (Images tab) come first. **When your uploads fill every place** (the featured design's photos plus the two body images), only they are used: no image search, no earlier photos and no photo check, also on **Regenerate images**. Your uploads go to the featured image, body 1 and body 2 in the order you uploaded them (a two-photo featured design takes the first two). When they are fewer, the photos collected before for the article, then the source below, add the rest; your uploads are never checked or moved down. The source is **Settings → SEO, links & images → Celebrity photo source**:
  - **ChatGPT image search gallery (default):** ChatGPT is asked, in the chat the article was written in, to search the web and show photos of the person. The extension opens the gallery, steps through it and saves the pictures; pictures on other sites are downloaded by the app (12 MB cap, private hosts blocked).
  - **Wikimedia Commons**, or **the gallery first with Commons as a fallback**.

  Pictures under 250 px and exact or near-duplicates are skipped. When ChatGPT answers with text only, it is asked once more in a new chat. Your featured template gets its photos first (a two-photo design gets two photos); the body images get the rest, and no photo is used twice.
- **As in the earlier tool (`markroger12/automation-old`):**
  - **Celebrity:** up to 10 gallery photos. **A collected photo (ChatGPT, Commons) is used until you press “Don't use”** (owner request): after your uploads, it fills the places still free. A photo that looks like a cropped copy of another one (the same faces in the same moment) comes last. On the Images tab, an unused photo says why. Photos with a clear face come first, the biggest face first, and soft (blurry) photos go last. The **photo check** (**Settings → SEO → Celebrity photo check**, on by default as in the earlier tool) shows the photos to ChatGPT in the article's chat, which says which ones carry a watermark or are another site's collage (photos side by side, a circle or frame drawn over people). Watermarked photos go last. A collage is never half of the featured image while there is another photo (it takes one only when every photo found is a collage), and it fills a body image only when one is still free. The alt text is “Name – what the photo shows”. **Regenerate images** uses the switch as it is today. A photo much taller than its place is shown whole on a blurred copy of itself instead of losing the face. A face or a person is never cut: when the people in a photo do not all fit its place (e.g. a group photo in half of a two-photo featured design), the photo is shown whole on a blurred copy of itself, and a narrow place takes an equally good photo whose people fit it, leaving the wide group photo for the 16:9 body image (needs the face detector; Framing “Center” or “Top” on the place crops anyway). A featured design with two or more photos takes photos with at most 2 people each; when there are not enough, it allows 3, then 4 and so on, place by place, and the Images tab says so. A single-photo featured design takes any number of people. When your featured design has more photo places than the photos found (e.g. one photo for a two-photo design), ChatGPT is asked for photos once more in a new chat; only when that brings nothing more is the built-in single-photo design used, and the Images tab says so. People are the faces and the people the detectors find; a crowd whose faces are turned away can count low. **Regenerate images** uses the photos collected before for the article again (*Don't use* on the Images tab leaves one out) and searches again only when they are fewer than four; a post the workflow already scheduled in WordPress gets the new images before its slot and stays scheduled.
  - **Tigram:** the three pictures are made one after another in the article's chat (a second try goes to a new chat). The featured picture carries a short title written by ChatGPT (the title before “:”, at most ~45 characters). The body pictures are simple flat illustrations without text. A picture ChatGPT hands back twice, or a missing one, is asked once more in a new chat.
  - **Every picture carries the website's logo:** without a body template, the logo goes in a corner.
- **Image tools from the earlier tool (optional):** The **face detector** (MediaPipe BlazeFace) and a **person detector** (MediaPipe EfficientDet-Lite0, 7 MB, so someone whose face is turned away or too small is not cut either) are downloaded into `data\tools\mediapipe` by `npm run start:all` / `dev:all` the first time (or by `npm run tools:install`). Photos with a face then come first and crops centre on the faces (locations only, never who it is). **Small or soft photos** are improved before cropping (**Settings → SEO → Enlarge small celebrity photos**, on by default):
  - **Upscayl** (the remacri-4x model of your earlier tool) enlarges a photo its place would stretch more than 2×, and sharpens a soft one.
    - `npm run start:all` (or `npm run tools:install`) downloads it the first time, about 40 MB: release 20251207-174704 of `upscayl-ncnn` and the model files from the Upscayl app.
    - Each file is checked against its pinned SHA-256 before it is kept; a file that differs is refused, and nothing is installed.
    - It goes into `data\tools\upscayl`. A copy you put there yourself (or one folder below) is used too.
  - **Built-in sharpener:** a photo stretched 1.3–2× (for example a 512-pixel photo in a half of the two-photo design), and any photo when Upscayl is missing or fails, is enlarged in 2× steps with Lanczos and an unsharp mask instead of one plain stretch. This takes well under a second; it gives less detail than Upscayl.
  - A missing tool never stops an article. The Images tab says which one was used.
- General articles ask ChatGPT for an image plan and three images through the extension. Missing images never block the text: the draft continues without them, or waits for review if the site requires images. No image-rights or licensing checks are performed (owner decision); the source URL is stored for reference only.
- After updating, reload the extension in Automation Chrome (version 3.1.0 adds image capture; 3.1.1–3.1.5 make prompts and answers readable on the new ChatGPT “Chat / Work” layout and recover an already-sent prompt after a page reload; 3.2.0 saves the image-search gallery for celebrity photos and asks for two more image hosts; 3.2.1 says exactly where the composer's text differed when a prompt cannot be placed; 3.2.2 accepts the space ChatGPT's composer puts after “](” in a link; 3.2.3 finds generated pictures as the earlier tool did, takes only the answer of its own prompt, and brings a hidden ChatGPT tab to the front while a picture is drawn; 3.2.4 finds the chat composer in the “Work” layout and lists the page's text boxes when it cannot; 3.2.5 reloads a ChatGPT page that stopped working — no composer or no Send button — once before the prompt is sent, and every retry after such a stop starts on a freshly loaded page; 3.2.6 also takes celebrity gallery pictures the ChatGPT page shows only as broken-picture icons, and the app downloads them from their address; 3.2.7 saves every picture of the gallery viewer (not only the 3 thumbnails shown) and leaves out the “Writing” label of ChatGPT's writing block; 3.3.0 requests indexing in Search Console (URL Inspection → Request indexing) and adds access to `search.google.com` — if Chrome asks to approve it, approve; 3.4.0 saves a copy of the Search Console page after each request, so the app can show a screenshot as proof (new `pageCapture` permission); 3.4.1 inspects the URL as you do — types it into “Inspect any URL in …” on the property's Search Console page — instead of opening a link Google answered with “404”; 3.4.2 saves the large picture of every gallery photo when ChatGPT's viewer slides or fades its pictures, or has no “Next” button — it then opens each photo by itself — and writes what it saw in the task log; 3.4.3 finds the dashboard by itself on this computer's ports 3000–3010 when it does not answer at its saved address, for the desktop app, which starts on a free port; 3.4.4 no longer takes Google's invisible reCAPTCHA for a check, so Search Console's live test is waited for and the screenshot saved, and when Google really shows a check it brings the tab to the front with a notification and waits for you; 3.4.5 opens a window for an indexing request when Automation Chrome runs in the background with every window closed; 3.4.6 leaves ChatGPT to the desktop app's own ChatGPT tab while that is connected — badge “APP”, no ChatGPT tab, no prompt taken — and keeps Search Console; 3.4.7 saves every photo of a gallery that shows fewer tiles than it has — e.g. 3 tiles with “5” on the last — by reading that count and stepping through the viewer with its Next arrow even when it has no name, with the arrow keys, or with the viewer's row of small pictures, and writes in the task log how it stepped; 3.4.8 makes sure Search Console's “Indexing requested” is on screen before the page is saved as proof; 3.4.9 finds ChatGPT's picture viewer also when it is a full-screen layer and the page keeps other, hidden dialogs, reads its “1 of 10”, waits for each picture to load after →, and tries the arrow keys when → changes nothing; 3.5.0 reloads itself from the `extension\` folder after an app update, when idle (no reload by hand from now on, with Load unpacked), and saves a copy of the page's structure — never its text — when it takes fewer gallery photos than ChatGPT shows or Search Console's answer may be missing from the proof, under Logs / Diagnostics → Page structure copies; 3.5.4 is the 3.5.0 code again, at the owner's request — the gallery, “still generating” and stall changes of 3.5.1–3.5.3 are taken back, and it reloads itself like 3.5.0).
- **Alt text** is checked for every rendered image:
  - “Image of …” is dropped and long text is shortened to 125 characters;
  - file names, web addresses, one-word labels, keyword stuffing and the same text on two images are replaced with a neutral text (the article title for the featured image, “*Subject*: article image 2/3” for body images);
  - every change is listed in the image notes. Alt text you edit in the article wins.
- **File names from the keyword** (owner request): an article's images are uploaded as `example-keyword.webp` (the featured image), then `example-keyword-2.webp`, `example-keyword-3.webp` … for the images in the article, in their order. The keyword is written in lower case with “-” between words; accents are dropped, and on German websites ä/ö/ü/ß become ae/oe/ue/ss. When the name already exists in the Media Library, WordPress adds “-1”. The file keeps its format (`.webp`, `.jpg` or `.png`). Images already in WordPress keep the name they were uploaded with.
- **Uploads happen once.** Each upload is sent with a unique attachment slug (the keyword plus a short tag), so if an upload's answer is lost (timeout), the next attempt finds it in the Media Library instead of uploading it again. An image that cannot be uploaded is left out of the draft with a note; the text is still saved.

## WordPress health

Each website page has tabs — **Session & categories**, **Health**, **Settings**, **Writer rules** and **Publishing** (the tab is kept in the address). **Health** shows only measured results, kept for 30 days:
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
- **Edited in WordPress?** When a draft was changed in WordPress after the app saved it, the app never overwrites it by itself, and the article stops for a choice of version.
  - **Approve** does not help here: it cannot decide which version to keep, so it says so. The same goes for the queue's Approve selected and the workflow's Force continue.
  - The article page offers **Keep the WordPress version** (the WordPress text becomes the article's text in the app, the app's version is kept as a revision, and the WordPress steps finish) or **Overwrite with the app version**.
  - **See what changed** opens the WordPress tab's **Changes made in WordPress**: the text only in the WordPress version next to the text only in the app version.
- WordPress's own “session expired” pop-up counts as logged out. An account that may not write posts stops with that reason instead of a generic error.

## Humanizer per website

The editorial humanizer is **off by default**. To turn it on for a website, go to Websites → edit → **Humanizer: On**. **Inherit global** follows Settings → Content. Updating turns the global switch off once; websites set to On keep it.

## The article page

- **Tabs** stay on one row: Overview, Titles, Research, Editor, SEO, Images, Links, Humanizer, Originality and WordPress. The technical tabs (**Stages**, **Prompt / Response**, **Logs**, **Conversation**) are under **More**.
- **Overview:**
  - the secondary keywords show as chips (8, then **+N more**) and the options in words;
  - the scores show as chips (Rank Math only when read from WordPress);
  - the timeline shows the time between steps;
  - long incident texts are shortened, with **more**.
- **Quality report** (top of Overview):
  - a summary line counts the hard stops and warnings;
  - **hard stops** are in a red box (“fix these first”);
  - **warnings** are grouped by where they come from (Research evidence, Article, SEO, …), each group with its link (e.g. **Open Research Evidence**) and one short line per warning with the quoted text. Click a line for the research notes and what to do. The first 4 are shown, and **Show all** shows the rest;
  - the checks (SEO readiness, Structure, Research evidence, Duplicates, Links, Images, Rank Math, WordPress) are small tiles with a green, amber or red dot.
- **Research:** each source page is listed once (ChatGPT cites many pages twice, with and without `?utm_source=chatgpt.com`), as the site and the page.
- **Images:** three tiles show which image is there or missing. The steps are under **How the images were made**.
- **Links:** each external link shows its phrase, then the site and the page on one line. The internal-link candidates have **Use this** on the right, and the chosen one says **in use**.

## Review, notes and deleting

- **Hold articles for review** (Settings → Workflow) is **off by default**:
  - review reasons never stop an article; they are shown as **Notes** on the article page — grouped by where they come from (Research evidence, Duplicates, Article, …), one short line each with the quoted text under it; click a note for the research notes and what to do, and use the group's link (e.g. **Open Research Evidence**) for the full page. The first 4 are shown, **Show all** shows the rest;
  - the WordPress draft is saved and the article is COMPLETED;
  - a draft with a serious problem (for example research notes left in the text, or much of its wording repeating another article) is still saved, but a workflow never publishes it automatically, and its keyword says why. To publish it anyway, select the keyword in the workflow's keyword queue and use **Force continue**: the dialog lists the problems you accept, and the draft is published at the next free slot (only where publishing is allowed). This is recorded in the audit log; Retry would only stop again.
  - Turn the switch on for the old *Needs review* behaviour.
- **Same-site duplicate keyword:** this still pauses before any ChatGPT work. **Approve selected**, **Allow duplicate and continue** and **Approve despite review reasons** all let it continue.
- **Delete articles:**
  - use the bin icon on a queue/history row, **Delete selected**, or **Delete** on the article page;
  - this removes the article from the app only. WordPress drafts and posts stay;
  - a report of each article is saved in `data\backups\deleted-articles` first;
  - a running article stops and is deleted when it stops.
- **Delete campaigns:** **Delete** on a campaign's page removes it, with or without its articles.
- **Delete workflow keywords:** select rows in Workflow → Keyword queue and choose **Delete**; tick the box to delete their articles from the app too.
- **A deleted article can be written again:** its WordPress post (never changed by the app) no longer counts as “already published” in Bulk Campaigns or the duplicate check. If that post is still published, trash it in WordPress when you do not want two posts.

## Editorial tools

- **Humanizer** (Editorial Tools → Humanizer): edits a saved article or pasted text paragraph by paragraph, in batches of about 1,200 words, through your ChatGPT session. Each rewrite is checked against **fact locks**: numbers, dates, quotations, names, links, bold/italic text, the keyword count, the language, a single paragraph, hedging such as “reportedly”, and length (±20 % by default). Any violation keeps the original paragraph and records the reason. Results show side by side with editorial diagnostics (empty phrases, repeated openers, sentence rhythm). It does **not** compute an “AI detection” score. A result reaches an article only when you click **Apply**, and the WordPress draft changes only when you re-save it.
- The same humanizer runs inside every article as the HUMANIZE stage, always starting from the unedited text. Settings → Content controls whether it is on, which paragraphs it edits (all or only flagged ones), the batch size and the length tolerance.
- **Plagiarism Evidence** (Editorial Tools → Plagiarism Evidence, or an article's **Originality** tab): compares a saved article or pasted text with your other saved articles (all websites), the pages it links to (up to 10), up to 10 URLs you add, Wikipedia extracts for the topic and — only if you put a `SERPER_API_KEY` for the licensed Serper search API in `.env` — web pages found for a few distinctive passages. It shows **identical runs of 8+ words** (verified word for word in the source) and **closely matching sentences** side by side with their source, plus a coverage list of everything that was or could not be compared. Quotations and text that recurs across your own site are not counted. There is no plagiarism score: read the evidence and decide. Search engine pages are never scraped; without a key, everything else still works.
- **Celebrity Writer 2.0 is retired.** Old 2.0 articles stay readable (outputs, post IDs, logs, prompts) but can't be run, queued or edited. If a backup is ever needed, the retirement migration's changes can be undone with `npm run db:rollback-retirement -- <backup-file>` from `data\backups\migrations\`.

## Campaigns and workflow

- **Bulk Campaigns** (sidebar → Bulk Campaigns → New): paste keywords (one per line, `keyword | secondary1, secondary2 | example title`, CSV or tab-separated columns from a spreadsheet; up to 1,000 rows) or load a file. The preview checks every row before anything is created: the writer (the Smart Router picks Tigram for clear topics; for person keywords and unclear ones you choose Celebrity, Celebrity 2 or Tigram), website and category, exact and near duplicates, existing tasks and already-published posts. Fix rows in the preview, then create; one article is queued per ready row and nothing is ever duplicated, even after a restart. Pause, resume, cancel, per-row retry/corrections and CSV export are on the campaign page. **Campaigns never publish.**
- **Workflow** (sidebar → Workflow): a keyword queue per website. **Settings** and **Add keywords** (top right, next to the website) open in a window; the queue fills the page:
  - **Add keywords → Preview** lists the keywords with a **writer** each (Celebrity, Celebrity 2, Tigram or Choose later). A person keyword is marked “(person)” and waits for your choice. **Person keywords** sets the writer of all of them, and **Writer for all** sets every line. A writer chosen there is saved as yours (the queue's “Chosen by you”);
  - **Keyword ideas** (next to Add keywords): **Search Console** lists searches that showed the website (impressions, clicks, average position, from the latest live or imported data) and that no keyword or article of the website has yet, most impressions first; **Google suggestions** finds Google's “related searches” and “People also ask” for a keyword you type or pick from the queue (one Serper search per Find; needs `SERPER_API_KEY` in `.env`). Tick ideas and **Add to queue**: they go through Add keywords (duplicates left out, writer detected); ones already in the queue or written are marked;
  - **newest first** by default (the keyword added last on top); **View → Order → Queue order** shows the order the articles are written in (remembered);
  - **pages** of 10–50 keywords (“Results per page”, “Page 1 of N”; the size is remembered), a **search**, a **Filter** by status, and **View** to hide columns;
  - the **keyword** opens its article page in the app (`/articles/<id>`) once an article was started for it; a keyword without an article yet stays plain text;
  - one line per keyword; Google's answer is shortened to one line with its times in Pakistan time — the arrow at its end shows the whole message;
  - **Links** are small buttons: live post, Search Console screenshot, inspect in Search Console;
  - with keywords selected: Retry, Force continue, Request indexing, **Move to day** and Delete, and under **More** the writer, To top, Skip, Restore, Mark requested and Mark indexed;
  - **Move to day** (e.g. select all → Tomorrow): the selected keywords take that day's free slots in queue order, and the window shows every new slot before anything changes. When the day has too few free slots, the rest go to the next day(s).
    - A post already scheduled in WordPress gets its new time in WordPress through the usual scheduling path (publishing permission, read back). A post WordPress publishes within 10 minutes is left as it is.
    - A keyword not started yet keeps its new slot and starts within the write-ahead time before it.
    - Published keywords are not moved, and your move does not count as one of the automatic moves.

  Slots, writer and the rest: Set publishing slots as `h:mm AM/PM` in **Pakistan time** (Asia/Karachi; daylight-saving-safe for the website's own clock), optional weekdays, how many hours ahead to start writing and how many articles may wait at once. Each keyword gets its own slot (two articles never share one); an article that is not ready by its slot moves to the next free slot, and stops after the retry limit with the reason. **Category:** a workflow keyword has no category of its own, so ChatGPT chooses one of the website's synchronized categories for each article (Celebrity and Tigram), offering “Uncategorized” only when the website has no other category; when ChatGPT names no existing category, the website's default is used. The category is never changed once the WordPress draft exists. A Tigram article from Single Article or Bulk without a category is chosen the same way; a category you choose is kept.
- **Publishing stays off** until you switch it on for a website and type the acknowledgement (Websites → the website → Publishing permission). Without it, workflow articles stay **verified drafts**; once their slot passes they are marked “draft kept (publish yourself)”. With it, the verified draft is **scheduled** in WordPress for its slot (never published early), read back to confirm, and checked again after the slot. A post you trash or change in WordPress is left alone.
- **Indexing**: with “Request indexing after publishing” on, about 35 seconds after a verified publish Automation Chrome opens the post in Search Console's **URL Inspection** and clicks **Request indexing**, as you do by hand.
  - How: it opens the property's Search Console page, types the post's URL into **“Inspect any URL in …”**, presses Enter, checks that the result shows that URL, then clicks **REQUEST INDEXING** and waits for Google's live test. If the box does not work, it opens Google's own inspection link instead (needs the Search Console key).
  - Sign in to Google once in Automation Chrome with the account that owns the property.
  - Search Console allows only a few requests a day; the rest are made the next day.
  - What Google answered is shown on the keyword. A sign-in page or a Google check is left to you and asked again an hour later (no request was made then).
  - **One request per article per day** (owner rule). This also applies to your own **Request indexing**, to **Request now**, and to a retry after an error. Such a request waits until a day after the last one, and the keyword says when.
  - **Is it on Google?** 24 hours after the request, Google search is asked through the search API (Serper: `site:` + the post's address; needs `SERPER_API_KEY` in `.env`). Search Console is not asked.
    - Found → **Indexed** (“Google: found in Google search …”).
    - Not found → indexing is requested again **48 hours after the last request** (so a day after the search), and searched again 24 hours after that request. Your own **Request indexing** and **Request now** still only wait for the one-a-day rule.
    - After 14 days without it, requests and searches stop.
    - Each search uses one Serper credit. Without the key, nothing is searched and the keyword says what to add.
  - **Is Automation Chrome signed in?** The Workflow and Automation Chrome pages have an **Indexing in Search Console** panel:
    - it shows whether Google is signed in there and what was requested or waits;
    - **Sign in to Google in Automation Chrome** opens Google's sign-in there (you type the password yourself);
    - **Request now** makes the waiting requests at once.
  - **Request indexing on the keyword queue:** select published keywords and click **Request indexing**. Automation Chrome makes the request now, also when the workflow switch was off or an earlier request was answered. An indexed keyword is left out. **Mark requested** and **Mark indexed** only record what you did yourself in Search Console.
  - **Proof:** after each request, a screenshot of Search Console as Automation Chrome saw it (“Indexing requested …”) is saved with the article. It is linked as **Search Console screenshot** in the keyword queue, and the latest one is shown in the panel; a click opens it over the page (not in a new tab), with **Download** and **Close** (or Esc). Since 3.4.8, Google's answer is in the screenshot also when its tab was in the background (where its dialog had not finished opening), and Google's icons no longer show as words such as “keyboard_arrow_down” (the copy cannot carry their font; they are left out).
  - Extension 3.4.0 asks Chrome for the `pageCapture` permission for this: it saves a copy of the page, which works even in a background tab or a minimized window. The copy is deleted once the screenshot is made.
- **Publishing Calendar** (sidebar, under Workflow): reserved and free slots of every workflow, two weeks at a time, in Pakistan time — seven days per row, each slot coloured by its state (the legend is above), free slots as one dashed line, today outlined; a click opens the article (or the queue for a free slot).

## Search Performance and Content Refresh

- **Search Performance** (sidebar → Productivity → Search Performance) shows only data you export from Google Search Console:
  1. In Search Console open **Performance → Search results**, choose the date range (optionally **Compare**), then **Export → Download CSV**.
  2. Upload the zip, or its CSV files.

  What you see:
  - The website needs its Search Console property first (website page → Settings tab, e.g. `sc-domain:example.com`). Until then the page says **NOT CONNECTED**; with a property but no import it says **NO VERIFIED DATA**.
  - **Live data** (service-account key on this page): the property is checked against the properties the key can use. A website added in Search Console as a URL prefix (`https://example.com/`) is found even when `sc-domain:example.com` was entered; the property in use is saved and shown. **Test connection** lists what the key can use.
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
- **Website Control** (sidebar, under Websites): summary tiles on top (websites, needing attention, may publish, queued or running, waiting for review), then one card per website with its health problem in one line, the articles by state (review and failed open the queue), and Pause / Priority / Max in progress at the bottom. **Copy settings** opens a window. Each card shows:
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
- Saved WordPress sign-ins (owner request: automatic login) are encrypted with AES-256-GCM in `data\credentials\wordpress-logins.json`, with a random key next to it (`wordpress-logins.key`); each entry is bound to its website. That protects against a copied database, log or screenshot, not against someone with the whole data folder (which holds the signed-in browser profiles anyway). The dashboard never gets a password back — only the user name and how the last automatic login went. The password is typed only into the website's own login page (same host as its admin address); a refused password is not tried again until you change it, so security plugins do not lock the account; CAPTCHAs and 2-step codes are always left to you. Remove a sign-in on the website's Session tab.
- Every outside page the app reads (link checks, images, plagiarism sources) goes through one SSRF-safe fetcher: public addresses only (checked again on every redirect), size and time limits, no cookies.
- Article HTML is allow-listed before it is saved and again before it is shown, including unsaved edits in the editor.
- Optional `SERPER_API_KEY` (plagiarism web search) stays in `.env`; it is sent only to that API and never logged or shown.
