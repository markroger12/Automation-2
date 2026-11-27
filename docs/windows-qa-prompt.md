# Windows test prompt for an AI agent

Owner's note (Roman Urdu):
- Yeh poora prompt apne laptop par kisi AI agent ko paste karein jis ke paas aap ke PC ka access ho (jaise Claude desktop app with computer use). Neeche "Prompt" wali line se aakhir tak copy karein.
- Agent app install karke har cheez check karega aur aakhir me `report.md` dega. Woh report yahan paste kar dein, main bugs theek kar dunga.
- Jahan password, API key, CAPTCHA, ya Google/ChatGPT/WordPress login aaye, agent ruk kar aap se kahega. Woh kaam aap khud karein.
- Is me woh tests hain jo cloud me nahi ho sakte: Windows installer, tray aur taskbar, app ke tabs, asli ChatGPT, Search Console aur Gemini, updates, memory.

---

## Prompt (copy everything below this line)

You are testing a Windows desktop program, **Blog Automation Studio**, on this PC, the way a careful QA tester would. Your job is to find bugs, crashes and anything that does not feel like a polished professional app, and to write a clear report. You do not change the program's code.

### Safety rules (always)
1. **Your files:** never delete, move or edit any file outside the report folder from step A1, the test data folder from step A3, and the app's own install folder. Never touch an existing Blog Automation Studio data folder (for example `F:\claude\Automation-2\data`).
2. **Secrets and sign-ins:** never type, read, copy or show a password or an API key. Never solve a CAPTCHA or complete a Google, ChatGPT or WordPress sign-in or human check. When one is needed, stop and ask the owner to do it, then continue. Do not screenshot a screen while the owner types a secret.
3. **No publishing:** never publish anything to a live website. An article you start must stay a WordPress **draft**. Do not turn on publishing for any website.
4. **Windows settings:** never change Windows security settings (Smart App Control, Defender, SmartScreen, firewall). If Windows blocks the installer, stop and report it.
5. **Ask first:** never uninstall anything, end processes you did not start, or restart the PC without asking the owner.
6. **Privacy:** do not send the owner's data anywhere. Screenshots and logs stay on this PC, in the report folder.

### A. Prepare
1. Make a report folder: `%USERPROFILE%\Desktop\BAS-QA`. Screenshots go there, named after the test (`B1.png`, `L3.png` …).
2. Open https://github.com/markroger12/Automation-2/releases/latest and download `Blog-Automation-Studio-Setup-<version>.exe`.
   - In PowerShell run `Get-FileHash <file> -Algorithm SHA256`.
   - Compare it with the `sha256:` digest GitHub shows next to the file, and record both.
3. Create an empty folder `%USERPROFILE%\Documents\BAS-QA-data` for the test data.

### B. Install and first start
1. **Run the installer.** Record:
   - whether Windows showed SmartScreen or Smart App Control (exact text and a screenshot);
   - whether it asked where to install, and the suggested folder;
   - how long installing took;
   - whether the app started by itself afterwards.
2. **Check the install:** a desktop shortcut and a Start-menu entry named "Blog Automation Studio" exist, and **Settings → Apps → Installed apps** lists "Blog Automation Studio <version>".
3. **Choose the data folder.** On the first start the app asks where to keep its data:
   - choose **Choose my data folder…** and pick `BAS-QA-data` from A3;
   - answer **Use it** when the app says there is no app.db in it yet;
   - record the exact dialogs and screenshot them.
4. **Watch the start card** (three steps: data, dashboard, worker). Record how many seconds pass until the dashboard appears. An error, a frozen step, or a flash of another colour is a finding.

### C. The window, tabs and menus
1. **Tab bar:**
   - It shows Dashboard, ChatGPT, Search Console and Chrome, the status chips on the right, and the version.
   - Screenshot it in light and in dark. The theme switch is at the bottom of the dashboard's sidebar; the tab bar must follow it within a few seconds.
2. **Shortcuts:** Ctrl+1, Ctrl+2 and Ctrl+3 switch tabs, also while the cursor is in a text box. Clicking the tabs works too.
3. **Menus:**
   - Press Alt: the menu bar shows **File, Edit, View, Help**. Try every item and record what it does.
   - Help → About shows the version and the data folder, and "Copy details" copies them.
   - Help → Keyboard shortcuts lists the shortcuts; try each one.
4. **Reload and zoom:** View → Reload this page (Ctrl+R), F5, Zoom in (Ctrl+=), Zoom out (Ctrl+-) and Actual size (Ctrl+0) act on the page shown, never on the tab bar.
5. **Right-click menus:**
   - in a text box: Cut, Copy, Paste, Select all;
   - on selected text: Copy;
   - on a website link: Copy link address, and Open link in browser opens the default browser.
6. **Window size and place:**
   - Resize to the minimum size and to full screen (F11): nothing overlaps or is cut off.
   - Move, maximize and close the window, then open it from the tray: it comes back at the same place and size (maximized if it was).

### D. Tray and taskbar (new)
1. **Closing the window:** the app stays in the tray, and a one-time balloon says so.
2. **Tray icon colour.** Hover over the icon each time and record the tooltip text:
   - grey when nothing runs;
   - blue while an article is written;
   - amber when something needs the owner;
   - a pause sign while paused.
3. **Tray menu:**
   - The first line is a status line (for example "Nothing running" or "1 article running").
   - Then **Pause all work / Resume work**.
   - Try every item.
4. **Taskbar button:**
   - while an article runs, a progress bar is on the app's taskbar button (yellow while paused);
   - an amber badge shows when something needs the owner;
   - the button flashes once when that starts while the window is in the background.
   Screenshot each state you see.
5. **Quit:** tray **Quit** closes everything. Afterwards no "Blog Automation Studio" process, and no `node` process it started, is left in Task Manager.

### E. Setup checklist (new)
1. **The Overview banner:** with the new test data, the Overview shows **Finish setting up · 0 of 3 done** with the next step and a button. Screenshot it.
2. **The buttons:**
   - **Open the ChatGPT tab** must switch the app to the ChatGPT tab.
   - On **Logs / Diagnostics → Setup checklist**, **Open the Search Console tab** must switch to the Search Console tab.
   Record whether each one works.
3. **Ticking off by itself:** after the owner signs in to ChatGPT (step G1), the ChatGPT step turns **Done** within about 10 seconds without reloading.
4. **Hiding:** **×** on the banner hides it, and **Show on the Overview** on the checklist page brings it back.

### F. Pause and quiet hours (new)
1. **Pause:**
   - Click **Pause** in the top bar: it turns into **Paused · Resume**.
   - The tray icon and the menus follow within 15 seconds.
   - Click again to resume.
2. **Quiet hours:**
   - Settings → Workflow → turn on **Quiet hours** with a range that includes the current time, and save.
   - The top bar shows **Quiet hours**; clicking it opens Settings.
   - Turn quiet hours off again and save.

### G. ChatGPT and Search Console tabs (with the owner)
1. **ChatGPT:** ask the owner to sign in to ChatGPT in the ChatGPT tab with email and password. The ChatGPT chip then turns green ("ready"). Record any sign-in error.
2. **Search Console:** ask the owner to sign in to Google in the Search Console tab. Record whether Google accepts the sign-in or shows "This browser or app may not be secure".
3. **One article, only if the owner agrees and a test website exists:**
   - Queue one article and watch it to the end. It must stay a **draft**.
   - On the article's page, the **Progress** card shows each step with its time, the running step with a live timer, and (after 3 or more finished articles) "about N min left".
   - Record each step's time, and whether the ChatGPT tab ever stops for more than 3 minutes.

### H. Help assistant (new; the owner reported a crash here)
1. **The key:** ask the owner to open **Settings → Help assistant**, paste their own Gemini API key, press **Save**, then **Test connection**. Do not read or copy the key yourself. Record what the test says.
2. **Questions.** Click **Ask** in the top bar and ask, one at a time, waiting for each answer:
   1. `how do i add website`
   2. `mera article kyun ruka?`
   3. `ChatGPT is not connected. What should I do?`
   4. a follow-up to the last answer, for example `aur uske baad?`
3. **Each answer:** record the answer's look (numbered steps, bold words, sub-points), how many seconds it took, and whether the page stayed usable.
4. **If something breaks.** If at any point the dashboard shows "Application error", "This page ran into a problem", a white or empty page, or the Ask button turns amber:
   1. Screenshot it.
   2. Open **Help → Troubleshooting → Developer tools (page shown)**, go to the **Console** tab, and copy every red error line and its stack into the report.
   3. Open **Logs / Diagnostics** (or **Help → Troubleshooting → Open the log**) and copy the lines that start with "Dashboard error in …".
   4. Press **Reload the page** or **Try again** and record whether the app recovers.
5. **What is sent:** open **What the assistant sees** at the bottom of the panel. Confirm it shows only states and counts: no password, key, cookie or article text.
6. **Copy:** under an answer, **Copy** copies the answer.

### I. Updates and robustness
1. **Check for updates:** Help → Check for updates says "You have the newest version", and Settings → App updates shows the same version.
2. **Server crash, only with the owner's OK:**
   - In Task Manager, end the app's dashboard server process (a `node`/Electron child process using the most memory).
   - The dashboard shows "Reconnecting to the dashboard…" and comes back by itself within about 30 seconds.
   - Record what happened.
3. **Memory:** after 5 minutes at idle, record memory and CPU with `Get-Process | Where-Object { $_.Path -like '*Blog Automation Studio*' } | Select Name,Id,CPU,WorkingSet64`.
4. **Second start:** quit and start the app again, and record the start time a second time.

### J. The dashboard, page by page
1. **Every page.** Visit every page in the left sidebar and its sub-pages. For each page record:
   - it loads without an error;
   - nothing is cut off at 1024×640 or when maximized;
   - light and dark both look right;
   - the texts read like a finished product (no developer commands such as `npm run …`, no placeholder text, no odd symbols, no spelling mistakes).
   Open Developer tools on any page that looks wrong and copy the red errors.
2. **Search and quick actions:**
   - Ctrl+K: "Quick actions" appear at once, including Setup checklist and Ask the help assistant. Each one opens the right page or panel.
   - Type "website", "bulk", "gemini" and "setup": the right results appear. Enter opens the first, and Esc closes the list.
3. **Websites → Add website:** try invalid input (an empty name, `not a url`, an empty password) and record the messages. Do not add a real website unless the owner asks.
4. **Settings:**
   - Change one harmless value (for example the notification switch), save, and reload: the change is kept. Then put it back.
   - **Send a test notification** shows a Windows notification.
5. **Backup:** Logs / Diagnostics → **Back up database + media** shows a success message, and the backup exists in the `backups` folder of the test data folder.

### K. The report
Write `%USERPROFILE%\Desktop\BAS-QA\report.md` with:
1. **Summary:**
   - the version tested and the Windows version;
   - total tests, passed and failed;
   - the 5 most important problems.
   Put any crash from H4 first.
2. **Results table:** one row per test (B1, B2 … K) with:
   - the result: PASS, FAIL, or SKIPPED and why;
   - what you did, what you expected and what happened;
   - the screenshot name.
3. **Bugs:** each with:
   - a short title and a severity (blocker / major / minor / cosmetic);
   - exact steps to reproduce;
   - expected vs actual;
   - console errors and "Dashboard error" log lines, copied in full.
4. **Professional feel:** anything that looks unfinished, confusing or "made by AI" (wording, alignment, spacing, inconsistent buttons, slow screens), with screenshots and a concrete suggestion.
5. **App details:**
   - the text from Help → Troubleshooting → **Copy details for a report**;
   - the last 100 lines of the log (Help → Troubleshooting → Open the log).

Then tell the owner the report is ready and where it is.
