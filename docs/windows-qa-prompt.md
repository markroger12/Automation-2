# Windows test prompt for an AI agent

Owner's note (Roman Urdu): yeh poora text apne laptop par AI agent (jaise Claude Code ya Claude desktop app with computer use) ko paste karein jis ke paas aap ke PC ka access ho. Agent app install kar ke har cheez check karega aur aakhir me ek report dega. Woh report mujhe yahan paste kar dein, main bugs theek kar dunga. Jahan password, CAPTCHA ya Google/ChatGPT login aaye, agent ruk kar aap se kahega; woh aap khud karein.

---

## Prompt (copy everything below this line)

You are testing a Windows desktop program, **Blog Automation Studio**, on this PC, the way a careful QA tester would. Your job is to find bugs, rough edges and anything that does not feel like a polished professional app, and to write a clear report. You do not change the program's code.

### Safety rules (always)
1. Never delete, move or edit any file outside the test data folder you create in step A3. Never touch an existing Blog Automation Studio data folder (for example `F:\claude\Automation-2\data`).
2. Never type a password, solve a CAPTCHA, or complete a Google, ChatGPT or WordPress sign-in or human check. When one is needed, stop and ask the owner to do it, then continue.
3. Never publish anything to a live website. If an article is created, it must stay a WordPress **draft**. Do not turn on publishing for any website.
4. Never change Windows security settings (Smart App Control, Defender, SmartScreen, firewall). If Windows blocks the installer, stop and report it.
5. Never uninstall anything, end processes you did not start, or restart the PC without asking the owner first.
6. Do not send the owner's data anywhere. Screenshots and logs stay on this PC, in the report folder.

### A. Prepare
1. Make a report folder: `%USERPROFILE%\Desktop\BAS-QA` (screenshots go here, named `A1.png`, `C3.png` …).
2. Open https://github.com/markroger12/Automation-2/releases/latest and download `Blog-Automation-Studio-Setup-<version>.exe`. In PowerShell run `Get-FileHash <file> -Algorithm SHA256` and compare it with the `sha256:` digest GitHub shows next to the file. Record both.
3. Create an empty folder `%USERPROFILE%\Documents\BAS-QA-data` for the test data.

### B. Install and first start
1. Run the installer. Record: did Windows show SmartScreen or Smart App Control (exact text and screenshot)? How long did installing take? Did the app start by itself afterwards?
2. Check: a desktop shortcut and a Start-menu entry named "Blog Automation Studio" exist; **Settings → Apps → Installed apps** lists "Blog Automation Studio <version>".
3. On the first start the app asks where to keep its data. Choose **Choose my data folder…**, pick `BAS-QA-data` from A3, and answer **Use it** when the app says there is no app.db in it yet. Record the exact dialogs and screenshot them.
4. Watch the start card (three steps: data, dashboard, worker). Record how many seconds until the dashboard appears. Any error, frozen step or flash of another colour is a finding.

### C. The window and the tab bar
1. The tab bar shows Dashboard, ChatGPT, Search Console and Chrome, status chips on the right, and the version (for example `v3.3.19`). Screenshot it in light and in dark (the theme switch is at the bottom of the dashboard's sidebar; the tab bar must follow it within a few seconds).
2. Ctrl+1, Ctrl+2 and Ctrl+3 switch tabs, also while the cursor is in a text box. Clicking the tabs works too.
3. Press Alt: the menu bar shows **File, Edit, View, Help**. Try every item and record what it does. Help → About shows the version and the data folder; "Copy details" copies them. Help → Keyboard shortcuts lists the shortcuts; try each one.
4. View → Reload this page (Ctrl+R), F5, Zoom in (Ctrl+=), Zoom out (Ctrl+-), Actual size (Ctrl+0) act on the page shown (dashboard, ChatGPT or Search Console), never on the tab bar.
5. Right-click: in a text box (Cut, Copy, Paste, Select all work), on selected text (Copy), on a website link (Copy link address, Open link in browser opens the default browser).
6. Resize the window to its minimum and to full screen (F11); nothing overlaps or is cut off. Move it, maximize it, close it, open it from the tray: it comes back at the same place and size (and maximized if it was).
7. Closing the window keeps the app in the tray (a one-time balloon says so). The tray menu items all work. **Quit** closes everything: afterwards no "Blog Automation Studio" or `node` process started by it is left in Task Manager.

### D. The dashboard, page by page
1. Visit every page in the left sidebar (and its sub-pages). For each page record: it loads without an error, nothing is cut off at 1024×640 and when maximized, light and dark both look right, and the texts read like a finished product (no developer commands such as `npm run …`, no placeholder text, no odd symbols, no spelling mistakes). Open Help → Troubleshooting → Developer tools on any page that looks wrong and copy red errors from its Console tab.
2. Ctrl+K (or click the search box at the top): "Quick actions" appear at once (New article, Add a website, New bulk campaign …); each one opens the right page. Type "website", "bulk", "write": the right results appear; Enter opens the first, Esc closes.
3. Websites → Add website: try invalid input (an empty name, `not a url`, a password left empty) and record the messages. Do not add a real website unless the owner asks.
4. Single Article: fill in a keyword and use **Preview Prompts**. Do not queue an article unless the owner agrees and a test website exists.
5. Settings: change one harmless value (for example the notification switch), save, reload: it is kept. Then put it back. **Send a test notification** shows a Windows notification.
6. Logs / Diagnostics → **Back up database + media**: a success message appears, and the backup exists in the `backups` folder of the test data folder.
7. Help / Setup: the page describes the desktop app (tabs, ChatGPT, Search Console, updates), not npm commands.

### E. ChatGPT and Search Console tabs (with the owner)
1. ChatGPT tab: ask the owner to sign in with email and password. Afterwards the ChatGPT chip turns green ("ready"). Record any sign-in error.
2. Search Console tab: ask the owner to sign in to Google. Record whether Google accepts the sign-in or shows "This browser or app may not be secure".
3. Only if the owner agrees and a test website exists: queue one article and watch it to the end (draft only). Record each step's time, and whether the ChatGPT tab ever stops for more than 3 minutes.

### F. Updates and robustness
1. Help → Check for updates: with the newest version it says "You have the newest version".
2. Only with the owner's OK: in Task Manager, end the app's dashboard server process (a `node`/Electron child process using the most memory). The dashboard shows "Reconnecting to the dashboard…" and comes back by itself within about 30 seconds. Record what happened.
3. Record memory and CPU at idle after 5 minutes: `Get-Process | Where-Object { $_.Path -like '*Blog Automation Studio*' } | Select Name,Id,CPU,WorkingSet64`.
4. Quit and start the app again: record the start time a second time.

### G. The report
Write `%USERPROFILE%\Desktop\BAS-QA\report.md` with:
1. **Summary**: version tested, Windows version, total tests, passed, failed, and the 5 most important problems.
2. **Results table**: one row per test (B1, B2, … F4) with Result (PASS / FAIL / SKIPPED and why), what you did, what you expected, what happened, and the screenshot name.
3. **Bugs**: each with a short title, severity (blocker / major / minor / cosmetic), exact steps to reproduce, expected vs actual, and log lines or console errors.
4. **Professional feel**: anything that looks unfinished, confusing or "made by AI" (wording, alignment, spacing, inconsistent buttons, slow screens), with screenshots and a concrete suggestion.
5. **App details**: paste the text from Help → Troubleshooting → Copy details for a report, and the last 100 lines of the log (Help → Troubleshooting → Open the log).

Then tell the owner the report is ready and where it is.
