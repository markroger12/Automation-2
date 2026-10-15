# Release checklist — Blog Automation Studio 3.0

Run before handing over a release. Each line says **where it can be verified**: *here* (automated in the repository, no accounts needed) or *owner PC* (needs your signed-in ChatGPT, your WordPress sites or the internet). Results and dates go in `BUILD_STATUS.md`; nothing is ticked without the command or check actually being run.

## 1. Install and upgrade (here + owner PC)

- [ ] `node --version` is 26 or newer; `npm install` succeeds.
- [ ] `npm run setup` on a **fresh** folder creates `data\`, `.env` and the database, and seeds prompts.
- [ ] `npm run setup` run **twice** changes nothing the second time and deletes no data.
- [ ] `npm run setup` on a copy of the **previous release's** `data\` folder: backup written, migrations applied, edited prompts and settings kept.
- [ ] `npm run dev:all` starts the dashboard and exactly one worker; a second worker refuses to start.

## 2. Quality gates (here)

- [ ] `npm run typecheck` — 0 errors.
- [ ] `npm test` — all unit tests pass.
- [ ] `npm run test:integration` — all integration tests pass (run file by file if the machine is busy; see BUILD_STATUS).
- [ ] `npm run test:e2e:wordpress` against a **disposable** WordPress (two versions): drafts, read-back verification, publish guard, featured image, Classic editor, approved scheduling path.
- [ ] `npm run build` — compiles.
- [ ] `npm run audit:a11y` with the app running — no serious or critical violations (light and dark).
- [ ] `npm audit --omit=dev` — every finding either fixed or recorded with the reason it is accepted (BUILD_STATUS, M11b).

## 3. Safety rules (here, by tests; spot-check on owner PC)

- [ ] No WordPress password is asked for, typed, stored or logged by the app (only the owner types it in the visible login window).
- [ ] Draft-only by default: with publishing off, no path (editor, REST, Quick Edit, retries, humanizer, workflow) can publish or schedule a post.
- [ ] Publishing needs the per-site switch **and** the typed acknowledgement, and runs only through the approved scheduler inside `withPublishPermit`.
- [ ] No OpenAI API; ChatGPT only through the signed-in Chrome window and the extension. The extension sends its key only to the local dashboard.
- [ ] No CAPTCHA solving or detection evasion: human checks pause the work and ask the owner.
- [ ] Exactly two active writers (Celebrity, Tigram); Celebrity Writer 2.0 records are read-only.
- [ ] No faked numbers: Rank Math scores only as read from the editor; indexing only as recorded by the owner; plagiarism shown as evidence, never a score.
- [ ] Diagnostic bundle contains no cookies, keys, tokens or passwords (unit test + open one bundle and search for `bas_`, `wordpress_logged_in`, `password`).

## 4. Owner PC — live checks (cannot be verified in the repository)

- [ ] Automation Chrome wizard: all five steps green; **Send test prompt** returns ChatGPT's answer.
- [ ] One **Celebrity** and one **Tigram** article from Single Article reach a verified WordPress draft on a real site (English), and one German article.
- [ ] Images: featured image and body images render with the site template and upload once; photos from Wikimedia Commons are reachable.
- [ ] Rank Math (if installed): focus keyword, SEO title and description visible in the editor; the score shown is the one Rank Math displays.
- [ ] Plagiarism Evidence: Wikipedia and linked pages are read (coverage list “compared”); with a `SERPER_API_KEY`, search results appear.
- [ ] Workflow on a site **with publishing allowed**: a draft is scheduled for its slot at the right local time and published by WordPress; on a draft-only site nothing is published.
- [ ] Backup and restore: `npm run db:backup -- --media`, then restore it into a copy and open the dashboard.
- [ ] **Throughput benchmark** (spec): with 3 article slots, at least 6 verified drafts per hour, measured end to end on real sites; record the numbers in BUILD_STATUS.

## 5. Hand-over

- [ ] `BUILD_STATUS.md` lists every command run for this release, what passed, and what was **not** verified.
- [ ] README “Updating” steps tested from the previous release.
- [ ] Extension version in `extension\manifest.json` matches the dashboard's expected version (Automation Chrome page shows no mismatch).
