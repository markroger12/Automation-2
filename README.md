# Blog Automation Studio

**A Windows app that writes research-led SEO articles with your own ChatGPT account and saves them as WordPress drafts: one article or hundreds a week, across all your websites.**

You give it keywords. It researches, writes, adds FAQs, a Quick Bio table, images and verified links, checks the result, and saves a WordPress draft with the Rank Math fields filled in. Everything runs on your own PC: no cloud service, no subscription, no account to create.

**[⬇ Download the newest version](https://github.com/markroger12/Automation-2/releases/latest)** (`Blog-Automation-Studio-Setup-<version>.exe`, Windows 10/11, 64-bit)

---

## Jaldi shuru (Roman Urdu)

1. Upar wale link se **Setup .exe** download karein aur chalayein. Installer poochega kahan install karna hai; aam tor par default theek hai.
2. Pehli baar app **data folder** poochegi. Purana folder hai (jaise `F:\claude\Automation-2\data`) to **Choose my data folder…**, warna **Start with a new data folder**.
3. Overview par **Finish setting up** card aayega. Us ke teen step karein:
   - **ChatGPT** tab (Ctrl+2) me sign in;
   - **Websites → Add website** (WordPress user name aur password);
   - **Single Article** se pehla article.
4. Koi sawal ho to upar **Ask** button dabayein (help assistant, Settings me free Gemini key daal kar).

---

## Contents

[Features](#features) · [Install](#install) · [Getting started](#getting-started) · [Everyday use](#everyday-use) · [Updates](#updates) · [Your data](#your-data) · [Privacy and security](#privacy-and-security) · [Troubleshooting](#troubleshooting) · [Documentation](#documentation)

## Features

| | |
| --- | --- |
| **Writes with your ChatGPT** | Prompts run in the app's own ChatGPT tabs, signed in with your account: several at once, like tabs in Chrome. No OpenAI API and no API costs. |
| **WordPress drafts, never surprises** | The app signs in to your websites by itself and saves every article as a **draft**, read back to verify it. Publishing happens only where you allowed it, per website. |
| **Writers** | Celebrity, Celebrity 2 and Tigram writers, plus your own writers built without code (prompts, title step, photo prompts), with import and export. |
| **Research and quality** | A research evidence ledger, a quality report with hard stops, duplicate and plagiarism evidence, verified external links and smart internal links. |
| **Images** | Featured and body images from your uploads, ChatGPT or generated designs, on your own image template, with face-safe crops and upscaling. |
| **Bulk and workflow** | Bulk campaigns, a weekly keyword workflow with publishing slots, a publishing calendar, and keyword ideas from Search Console. |
| **Search Console** | Indexing requests in the app's Search Console tab, with proof; search performance from your own exports; content refresh suggestions. |
| **Live progress** | Each article shows its steps live, with how long each took and about how long is left, from your own earlier articles. |
| **Work at a glance** | The tray icon and the taskbar show what the app is doing; **Pause** stops new work with one click; **quiet hours** pause it every night. |
| **Help assistant** | Ask questions about the app in English or Roman Urdu from the **Ask** button (optional, with your free Google Gemini key). |

## Install

1. Download **Blog-Automation-Studio-Setup-&lt;version&gt;.exe** from the [Releases page](https://github.com/markroger12/Automation-2/releases/latest).
2. Run it. It asks where to install: the default, your user's `AppData\Local\Programs`, needs no administrator rights; another folder such as `C:\Program Files` works too. It adds a desktop and a Start-menu shortcut and starts the app.
3. The installer is not code-signed, so Windows SmartScreen may say *unknown publisher*: choose **More info → Run anyway**.

You need: Windows 10 or 11 (64-bit), a ChatGPT account, and a WordPress website with a user that can write posts. Nothing else to install: no Node.js, no Chrome extension, no command window.

## Getting started

**On the first start** the app asks for its **data folder**, where your articles, settings and sign-ins live:
- **Choose my data folder…** to keep using an existing one;
- **Start with a new data folder** for a fresh start.

A start card then shows the three start-up steps (data, dashboard, worker).

**The Setup checklist** then guides you. It shows on the Overview until the needed steps are done, and stays under *Logs / Diagnostics → Setup checklist*. Each step ticks itself off as soon as it really works:

| Step | Where |
| --- | --- |
| 1. Connect ChatGPT | The **ChatGPT** tab at the top (Ctrl+2): sign in with your email and password. |
| 2. Add your WordPress website | **Websites → Add website**: the address, user name and password. The app signs in by itself. |
| 3. Write your first article | **Single Article**: a keyword, the website and the writer, then **Generate**. |
| Optional: check the settings | **Settings**: ChatGPT tabs, article slots, review before WordPress, quiet hours, notifications. |
| Optional: Search Console | The **Search Console** tab (Ctrl+3): sign in to Google once, for indexing requests. |
| Optional: help assistant | **Settings → Help assistant**: paste a free Gemini API key from [aistudio.google.com](https://aistudio.google.com/app/apikey). |

## Everyday use

**The window**
- **Tabs:** **Dashboard** (Ctrl+1), **ChatGPT** (Ctrl+2; one tab per running prompt, like Chrome) and **Search Console** (Ctrl+3).
- **Status chips** on the right of the tab bar say what ChatGPT, Search Console and the work are doing.
- **Ctrl+K** searches every page and offers quick actions: New article, Add a website, New bulk campaign, Setup checklist, Ask the help assistant, and more.
- The top bar has **Pause**, **Ask** (help assistant) and the **bell** (what needs you).
- Press **Alt** for the menus. **Help → Keyboard shortcuts** lists all shortcuts.

**The tray and the taskbar**
- Closing the window keeps the app running in the tray, so scheduled work goes on. **Quit** in the tray menu stops it safely.
- The tray icon and the taskbar button show the state: idle, writing (with a progress bar), something needs you (amber), or paused.
- The tray menu also has Pause / Resume, the data folder, the log, and *Start with Windows*.

**Articles**
- **Single Article** writes one article. **Bulk Campaigns** imports many keywords. **Workflow / Calendar** plans keywords per day with publishing slots.
- **Article Queue** shows what runs and what waits for you. **Article History** keeps everything.
- An article's page shows its live progress with the time left, and the tabs for titles, research, editor, SEO, images, links, WordPress and more. **Retry** and **Regenerate** are there.
- A sign-in page, a CAPTCHA or a human check is never done by the app. The article waits, the app shows you where, and it goes on after you finish it.

**Pause and quiet hours**
- **Pause** stops new work at once: running prompts finish, and everything else waits in the queue.
- **Settings → Workflow → Quiet hours** does the same every night (for example 23:00–07:00).

**Help**
- **Help / Setup** in the app explains every part.
- The **Ask** button answers questions using the app's current state. It shows exactly what it sends, and never sends passwords, keys or article texts.
- The full reference is the **[user guide](docs/user-guide.md)**.

## Updates

The app updates itself from this repository's Releases:
- It looks for a new version 30 seconds after it starts and every 6 hours, and downloads it in the background. **Help → Check for updates** looks at once.
- When the download is done, the tab bar and a notification offer **Restart to update**. It stops the work safely first; prompts go back to the queue and continue after the restart.
- **Settings → App updates** shows the installed version and the updater's progress.

Your data folder is never touched by an update, and uninstalling never deletes it.

## Your data

Everything stays in your **data folder** (*File → Open the data folder*):
- the database with your articles and settings;
- the encrypted sign-ins;
- the ChatGPT and website browser profiles;
- images, logs and backups.

**Logs / Diagnostics → Back up database + media** makes a consistent backup in its `backups` folder, also while the app works. To move to another PC, quit the app, copy the whole data folder, and choose it with **Choose my data folder…** on the new PC.

Treat the data folder like a password: it holds your signed-in sessions.

## Privacy and security

- **Local only:** the dashboard listens on this PC only (127.0.0.1) and accepts no requests from other websites. There is no login screen, because no one else can reach it.
- **Passwords:**
  - WordPress passwords are encrypted (AES-256-GCM) in the data folder. They are never written to the database, a log, a backup or a report, and never shown again.
  - They are typed only into your website's own login page. A refused password is not tried again until you change it.
- **CAPTCHAs and checks** are never solved by the app; they are left to you.
- **Drafts by default:** nothing is published without the website's own publish permission.
- **ChatGPT** is used only through your signed-in ChatGPT tab, never through the OpenAI API. Google is used through your own Search Console sign-in. Web search uses the licensed Serper API, only with your key.
- **Help assistant:** your Gemini key is stored encrypted like the passwords. Each question sends only a short, secret-free status of the app, which the panel shows.
- **Logs and diagnostic bundles** remove cookies, tokens, keys and passwords.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| Windows says *unknown publisher* | **More info → Run anyway** (the installer is not code-signed). |
| The **ChatGPT** chip is amber | Open the ChatGPT tab (Ctrl+2): sign in, or finish the check ChatGPT shows. Waiting articles go on by themselves. |
| ChatGPT does not work in the app | Untick **File → Run ChatGPT prompts in this app**. Automation Chrome then takes the prompts (see the [user guide](docs/user-guide.md#the-desktop-app-in-detail)). |
| “WordPress login required” | Open the website's page. With a saved password the app signs in again by itself; a CAPTCHA or 2-step code opens a window for you. |
| Nothing starts | Check **Pause** in the top bar and the quiet hours in **Settings → Workflow**. |
| “Reconnecting to the dashboard…” | The dashboard restarts by itself after a crash, usually within 30 seconds. |
| “This page ran into a problem” | **Try again** or **Reload the page**; your work keeps running in the background. If it comes back, **Copy details** and send them: the error is also in the app's log. |
| An article stopped | Its page says why and what to do. **Retry** continues it, and the **Ask** button explains the message. |
| Anything else | **Help → Troubleshooting → Copy details for a report**, plus **Logs / Diagnostics → Download diagnostic bundle** (secrets removed). |

## Documentation

- **[User guide](docs/user-guide.md):** every page and setting in detail.
- **[Running from source and development](docs/development.md):** the npm copy, scripts, tests, building the installer.
- **[Windows test prompt](docs/windows-qa-prompt.md):** a ready prompt for an AI agent to test the app on your PC.
- **[BUILD_STATUS.md](BUILD_STATUS.md):** what changed, how it was verified, known limits. **[RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md):** release steps.
