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

Find any page with the **search box** above Overview (Ctrl+K); “Articles: …” searches your articles.

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

- **Install:** download **Blog-Automation-Studio-Setup-….exe**. It is built by GitHub Actions (“Desktop app (Windows installer)” → the latest run → *Artifacts*). Run it: it installs with one click for your Windows user only (no administrator), adds a desktop and a Start-menu shortcut, and starts the app. The installer is not code-signed, so Windows SmartScreen may say “unknown publisher”: *More info* → *Run anyway*.
- **First start:** the app asks for the **data folder**.
  - **Choose my data folder…** uses the one `npm run start:all` uses (for example `F:\claude\Automation-2\data`), with the same websites, articles, settings and Automation Chrome profile.
  - **Start with a new data folder** creates an empty one in the app's own folder.
  - A `.env` next to that data folder (e.g. with `SERPER_API_KEY`) is read too.
- **Daily use:** the window shows the dashboard. The server and the worker run hidden, on the app's own built-in Node.js. Automation Chrome and the extension work as before.
- **No port to manage:** the dashboard starts on the first free port from 3000 to 3010, and the extension (3.4.3) finds it there by itself. When the tool already runs on the same data folder (e.g. `npm run start:all`), the window shows that one instead of starting a second copy. If the app is closed in any way, even by a crash, its server and worker stop too.
- **Closing the window** keeps the app in the tray (by the clock), so the workflow keeps running. The tray menu has:
  - *Open*, *Automation Chrome*;
  - *Open the data folder*, *Open the log*;
  - *Start with Windows*;
  - *Keep running when the window is closed*;
  - *Use another data folder…*;
  - **Quit**, which stops the worker safely, then the server.
- **Updating:** run the newer installer; your data folder is never touched. Uninstalling never deletes it either.
- **What is inside:** the built dashboard, the worker, the migrations and settings steps (run at every start, with a backup first), and only the packages those load. Electron 44.7.0 provides the window and, with its built-in Node.js 24.21, runs the tool; the whole test suite passes on that Node.js too. The window's texts are English only.
- **Building it yourself:** in the repository root run `npm ci` and `npm run build`. In `desktop\` run `npm ci`. Back in the root run `node desktop/prepare.mjs` and `node desktop/check-bundle.mjs`, which runs a copy of the bundle outside the repository, as the installed app does. Then in `desktop\` run `npm run dist:win`. The installer is written to `desktop\dist`. The GitHub workflow also installs it and starts the app once (`--smoke-test`).

## First run

1. **Automation Chrome** (sidebar): follow the five checked steps — start the dedicated Chrome window, load the unpacked extension from the `extension\` folder, paste the one-time connection key, sign in to ChatGPT yourself. “Send test prompt” proves the round trip.
   After setup you do not need to keep it open: when you queue an article, or a Search Console indexing request is due, the worker opens Automation Chrome by itself, and closes it again (normally, never forced) 2 minutes after the queue is done. When Chrome still runs in the background with its windows closed, a window is opened in it for the waiting work. A Chrome window you opened yourself is never closed. Both switches are in **Settings → Browser**; when Chrome was not opened, **Logs** says why once.
2. **Websites → Add website**: public URL, language, country and time zone. Then **Log in** opens a visible window where *you* sign in to WordPress (leave “Remember Me” ticked, or the sign-in ends when the window closes). **Sync categories** and pick a default category.
3. **Single Article**: enter a keyword and generate. The finished article is saved as a **WordPress draft** and read back to verify it.
4. Optional: **Bulk Campaigns**, **Workflow / Calendar**, **Image Template**, **Settings**.

## Updating

```powershell
# stop npm run dev:all / start:all first
git pull
npm install
npm run start:all      # migrates (with backup), seeds and rebuilds by itself when needed
```

`npm run setup` and `npm run build` still work on their own, for example to see each step.

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
- Celebrity articles collect a bounded photo gallery, as in the earlier tool. Your own uploads (Images tab) come first; after that the source is **Settings → SEO, links & images → Celebrity photo source**:
  - **ChatGPT image search gallery (default):** ChatGPT is asked, in the chat the article was written in, to search the web and show photos of the person. The extension opens the gallery, steps through it and saves the pictures; pictures on other sites are downloaded by the app (12 MB cap, private hosts blocked).
  - **Wikimedia Commons**, or **the gallery first with Commons as a fallback**.

  Pictures under 250 px and exact or near-duplicates are skipped. When ChatGPT answers with text only, it is asked once more in a new chat. Your featured template gets its photos first (a two-photo design gets two photos); the body images get the rest, and no photo is used twice.
- **As in the earlier tool (`markroger12/automation-old`):**
  - **Celebrity:** up to 10 gallery photos. A cropped copy of the same photo (the same faces in the same moment) counts once. Photos with a clear face come first, the biggest face first, and soft (blurry) photos go last. The **photo check** (**Settings → SEO → Celebrity photo check**, on by default as in the earlier tool) shows the photos to ChatGPT in the article's chat, which says which ones carry a watermark or are another site's collage (photos side by side, a circle or frame drawn over people). Watermarked photos go last; collages are left out, and the featured image takes one only when every photo found is a collage. The alt text is “Name – what the photo shows”. **Regenerate images** uses the switch as it is today. A photo much taller than its place is shown whole on a blurred copy of itself instead of losing the face. A face or a person is never cut: when the people in a photo do not all fit its place (e.g. a group photo in half of a two-photo featured design), the photo is shown whole on a blurred copy of itself, and a narrow place takes an equally good photo whose people fit it, leaving the wide group photo for the 16:9 body image (needs the face detector; Framing “Center” or “Top” on the place crops anyway). A featured design with two or more photos takes photos with at most 2 people each; when there are not enough, it allows 3, then 4 and so on, place by place, and the Images tab says so. A single-photo featured design takes any number of people. When your featured design has more photo places than the photos found (e.g. one photo for a two-photo design), ChatGPT is asked for photos once more in a new chat; only when that brings nothing more is the built-in single-photo design used, and the Images tab says so. People are the faces and the people the detectors find; a crowd whose faces are turned away can count low. **Regenerate images** uses the photos collected before for the article again (*Don't use* on the Images tab leaves one out) and searches again only when they are fewer than four; a post the workflow already scheduled in WordPress gets the new images before its slot and stays scheduled.
  - **Tigram:** the three pictures are made one after another in the article's chat (a second try goes to a new chat). The featured picture carries a short title written by ChatGPT (the title before “:”, at most ~45 characters). The body pictures are simple flat illustrations without text. A picture ChatGPT hands back twice, or a missing one, is asked once more in a new chat.
  - **Every picture carries the website's logo:** without a body template, the logo goes in a corner.
- **Image tools from the earlier tool (optional):** The **face detector** (MediaPipe BlazeFace) and a **person detector** (MediaPipe EfficientDet-Lite0, 7 MB, so someone whose face is turned away or too small is not cut either) are downloaded into `data\tools\mediapipe` by `npm run start:all` / `dev:all` the first time (or by `npm run tools:install`). Photos with a face then come first and crops centre on the faces (locations only, never who it is). **Upscayl** enlarges a photo its place would stretch more than 2×, and sharpens a soft one, before cropping (**Settings → SEO → Enlarge small celebrity photos**, on by default; one folder below `data\tools\upscayl` is found too, as its zip unpacks): download `upscayl-ncnn` from https://github.com/upscayl/upscayl-ncnn/releases, put `upscayl-bin.exe` in `data\tools\upscayl` and the `remacri-4x.param` / `remacri-4x.bin` model files (from the Upscayl app's `resources\models`) in `data\tools\upscayl\models`. A missing tool never stops an article; the Images tab says it was not used.
- General articles ask ChatGPT for an image plan and three images through the extension. Missing images never block the text: the draft continues without them, or waits for review if the site requires images. No image-rights or licensing checks are performed (owner decision); the source URL is stored for reference only.
- After updating, reload the extension in Automation Chrome (version 3.1.0 adds image capture; 3.1.1–3.1.5 make prompts and answers readable on the new ChatGPT “Chat / Work” layout and recover an already-sent prompt after a page reload; 3.2.0 saves the image-search gallery for celebrity photos and asks for two more image hosts; 3.2.1 says exactly where the composer's text differed when a prompt cannot be placed; 3.2.2 accepts the space ChatGPT's composer puts after “](” in a link; 3.2.3 finds generated pictures as the earlier tool did, takes only the answer of its own prompt, and brings a hidden ChatGPT tab to the front while a picture is drawn; 3.2.4 finds the chat composer in the “Work” layout and lists the page's text boxes when it cannot; 3.2.5 reloads a ChatGPT page that stopped working — no composer or no Send button — once before the prompt is sent, and every retry after such a stop starts on a freshly loaded page; 3.2.6 also takes celebrity gallery pictures the ChatGPT page shows only as broken-picture icons, and the app downloads them from their address; 3.2.7 saves every picture of the gallery viewer (not only the 3 thumbnails shown) and leaves out the “Writing” label of ChatGPT's writing block; 3.3.0 requests indexing in Search Console (URL Inspection → Request indexing) and adds access to `search.google.com` — if Chrome asks to approve it, approve; 3.4.0 saves a copy of the Search Console page after each request, so the app can show a screenshot as proof (new `pageCapture` permission); 3.4.1 inspects the URL as you do — types it into “Inspect any URL in …” on the property's Search Console page — instead of opening a link Google answered with “404”; 3.4.2 saves the large picture of every gallery photo when ChatGPT's viewer slides or fades its pictures, or has no “Next” button — it then opens each photo by itself — and writes what it saw in the task log; 3.4.3 finds the dashboard by itself on this computer's ports 3000–3010 when it does not answer at its saved address, for the desktop app, which starts on a free port; 3.4.4 no longer takes Google's invisible reCAPTCHA for a check, so Search Console's live test is waited for and the screenshot saved, and when Google really shows a check it brings the tab to the front with a notification and waits for you; 3.4.5 opens a window for an indexing request when Automation Chrome runs in the background with every window closed; 3.4.6 leaves ChatGPT to the desktop app's own ChatGPT tab while that is connected — badge “APP”, no ChatGPT tab, no prompt taken — and keeps Search Console).
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

## Humanizer per website

The editorial humanizer is **off by default**. To turn it on for a website, go to Websites → edit → **Humanizer: On**. **Inherit global** follows Settings → Content. Updating turns the global switch off once; websites set to On keep it.

## Review, notes and deleting

- **Hold articles for review** (Settings → Workflow) is **off by default**:
  - review reasons never stop an article; they are shown as **Notes** on the article page;
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

- **Bulk Campaigns** (sidebar → Bulk Campaigns → New): paste keywords (one per line, `keyword | secondary1, secondary2 | example title`, CSV or tab-separated columns from a spreadsheet; up to 1,000 rows) or load a file. The preview checks every row before anything is created: the writer (the Smart Router picks Celebrity or Tigram and asks you when unsure), website and category, exact and near duplicates, existing tasks and already-published posts. Fix rows in the preview, then create; one article is queued per ready row and nothing is ever duplicated, even after a restart. Pause, resume, cancel, per-row retry/corrections and CSV export are on the campaign page. **Campaigns never publish.**
- **Workflow** (sidebar → Workflow): a keyword queue per website. Set publishing slots as `h:mm AM/PM` in **Pakistan time** (Asia/Karachi; daylight-saving-safe for the website's own clock), optional weekdays, how many hours ahead to start writing and how many articles may wait at once. Each keyword gets its own slot (two articles never share one); an article that is not ready by its slot moves to the next free slot, and stops after the retry limit with the reason. **Category:** a workflow keyword has no category of its own, so ChatGPT chooses one of the website's synchronized categories for each article (Celebrity and Tigram), offering “Uncategorized” only when the website has no other category; when ChatGPT names no existing category, the website's default is used. The category is never changed once the WordPress draft exists. A Tigram article from Single Article or Bulk without a category is chosen the same way; a category you choose is kept.
- **Publishing stays off** until you switch it on for a website and type the acknowledgement (Websites → the website → Publishing permission). Without it, workflow articles stay **verified drafts**; once their slot passes they are marked “draft kept (publish yourself)”. With it, the verified draft is **scheduled** in WordPress for its slot (never published early), read back to confirm, and checked again after the slot. A post you trash or change in WordPress is left alone.
- **Indexing**: with “Request indexing after publishing” on, about 35 seconds after a verified publish Automation Chrome opens the post in Search Console's **URL Inspection** and clicks **Request indexing**, as you do by hand.
  - How: it opens the property's Search Console page, types the post's URL into **“Inspect any URL in …”**, presses Enter, checks that the result shows that URL, then clicks **REQUEST INDEXING** and waits for Google's live test. If the box does not work, it opens Google's own inspection link instead (needs the Search Console key).
  - Sign in to Google once in Automation Chrome with the account that owns the property.
  - Search Console allows only a few requests a day; the rest are made the next day.
  - What Google answered is shown on the keyword. A sign-in page or a Google check is left to you and asked again an hour later.
  - The tool never claims a post is indexed: “Indexed” comes only from Google's URL Inspection (needs the Search Console key on the Search Performance page).
  - **Is Automation Chrome signed in?** The Workflow and Automation Chrome pages have an **Indexing in Search Console** panel:
    - it shows whether Google is signed in there and what was requested or waits;
    - **Sign in to Google in Automation Chrome** opens Google's sign-in there (you type the password yourself);
    - **Request now** makes the waiting requests at once.
  - **Request indexing on the keyword queue:** select published keywords and click **Request indexing**. Automation Chrome makes the request now, also when the workflow switch was off or an earlier request was answered. An indexed keyword is left out. **Mark requested** and **Mark indexed** only record what you did yourself in Search Console.
  - **Proof:** after each request, a screenshot of Search Console as Automation Chrome saw it (“Indexing requested …”) is saved with the article. It is linked as **Search Console screenshot** in the keyword queue, and the latest one is shown in the panel.
  - Extension 3.4.0 asks Chrome for the `pageCapture` permission for this: it saves a copy of the page, which works even in a background tab or a minimized window. The copy is deleted once the screenshot is made.
- **Publishing Calendar** (sidebar, under Workflow): reserved and free slots of every workflow, two weeks at a time, in Pakistan time.

## Search Performance and Content Refresh

- **Search Performance** (sidebar → Productivity → Search Performance) shows only data you export from Google Search Console:
  1. In Search Console open **Performance → Search results**, choose the date range (optionally **Compare**), then **Export → Download CSV**.
  2. Upload the zip, or its CSV files.

  What you see:
  - The website needs its Search Console property first (website page → Settings, e.g. `sc-domain:example.com`). Until then the page says **NOT CONNECTED**; with a property but no import it says **NO VERIFIED DATA**.
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
