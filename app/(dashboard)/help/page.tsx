import Link from 'next/link';
import { Card, PageHeader } from '@/components/ui';
import { inDesktopApp } from '@/lib/runtime';
import { AskAssistantButton } from '@/components/assistant';

export const metadata = { title: 'Help / Setup' };

function Code({ children }: { children: string }) {
  return <code className="surface-2 rounded px-1.5 py-0.5 font-mono text-[13px]">{children}</code>;
}

/** The desktop app's own first cards (owner request 2026-11-12: a finished program, no npm commands in it). */
function DesktopStart() {
  return (
    <>
      <Card title="1 · Start">
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>Open <strong>Blog Automation Studio</strong> from the Start menu or the desktop. The dashboard and the worker start by themselves; there is nothing else to install or keep open.</li>
          <li>The first start asks for the <strong>data folder</strong>: your articles, settings and sign-ins. <strong>Help → About</strong> shows which one is in use.</li>
          <li>Closing the window keeps the app running in the tray, next to the clock, so the workflow keeps going. Right-click the tray icon → <strong>Quit</strong> stops it safely.</li>
          <li>
            The <Link className="link" href="/setup">Setup checklist</Link> shows what is still needed before the first article (ChatGPT, a website, the first article) and ticks each step off by itself.
          </li>
        </ol>
      </Card>
      <Card title="2 · The tabs at the top">
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            <strong>Dashboard</strong> (Ctrl+1), <strong>ChatGPT</strong> (Ctrl+2) and <strong>Search Console</strong> (Ctrl+3). <strong>Ctrl+K</strong> searches pages and quick actions such as New article or Add a website.
          </li>
          <li>The chips on the right say what ChatGPT and Search Console are doing: green is ready, amber needs you, red is a problem. Hover over one for the whole text.</li>
          <li>Right-click copies and pastes, Ctrl+R reloads the page shown, Ctrl+Plus and Ctrl+Minus zoom it. <strong>Help → Keyboard shortcuts</strong> lists them all.</li>
        </ol>
      </Card>
    </>
  );
}

export default function HelpPage() {
  const desktop = inDesktopApp();
  return (
    <>
      <PageHeader
        title="Help / Setup"
        description={`${desktop ? 'How to use the app. Everything runs on this computer.' : 'Windows-first setup for this private, local tool.'} Only the optional help assistant sends a question, with a short status of the app, to Google Gemini.`}
        actions={<AskAssistantButton />}
      />
      <div className="grid gap-6 lg:grid-cols-2">
        {desktop ? <DesktopStart /> : null}
        <Card title="1 · Install (once)" className={desktop ? 'hidden' : undefined}>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>Install the latest <strong>Node.js</strong> (v26 or newer) from nodejs.org and <strong>Google Chrome</strong>.</li>
            <li>
              Open <em>PowerShell</em> in the project folder and run <Code>npm install</Code> then <Code>npm run setup</Code>.
            </li>
            <li>Setup creates <Code>data\</Code>, a <Code>.env</Code> (only if missing), migrates the database (with a backup) and seeds default prompts. Running it again is safe.</li>
          </ol>
        </Card>
        <Card title="2 · Start every day" className={desktop ? 'hidden' : undefined}>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              Run <Code>npm run start:all</Code> and keep that window open. It prepares the database and builds the dashboard by itself when needed (<Code>npm run dev:all</Code> is for development).
            </li>
            <li>
              Open <Code>http://localhost:3000</Code>. There is no login: the dashboard only listens on this computer (127.0.0.1).
            </li>
            <li>Only one worker may run at a time — a second one refuses to start.</li>
          </ol>
        </Card>
        <Card title="3 · WordPress websites">
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>Websites → Add website (public URL, admin URL, language, timezone).</li>
            <li>
              Give the WordPress <strong>user name and password</strong> when you add the website (or later on its Session tab): the app logs in by itself, with “Remember me”, and again whenever the session ends. They are saved encrypted on this computer only and typed only into the website's own login page. A CAPTCHA or a 2-step code opens a window where you do that step; without a saved sign-in, <strong>Log in yourself</strong> opens the window for the whole sign-in.
            </li>
            <li>Click <strong>Sync categories</strong>. Drafts are created as drafts only; publishing needs the per-site switch plus the scheduler.</li>
            <li>
              Click <strong>Test session</strong>: it also checks that the WordPress REST API answers for the logged-in user (the block editor needs it too) and whether Rank Math is active. Drafts are saved through
              that logged-in session — no Application Password is used.
            </li>
            <li>
              Rank Math: fields are set and the score is read from the editor. Without Rank Math, choose “Use when installed” (site settings) so drafts can still complete; with “Required” the article stays in
              review.
            </li>
          </ol>
        </Card>
        {desktop ? (
          <Card title="4 · ChatGPT and Search Console">
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>Open the <strong>ChatGPT</strong> tab once and sign in with your email and password. The prompts run there, several at once (Settings → ChatGPT tabs).</li>
              <li>Open the <strong>Search Console</strong> tab once and sign in to Google. Indexing requests are then made there by themselves.</li>
              <li>A sign-in page or a human check is never filled in by the app: a notification appears, the tab opens, and the job waits for you.</li>
              <li>A ChatGPT tab that shows no progress for 3 minutes is loaded again by itself; a prompt is never sent twice.</li>
            </ol>
          </Card>
        ) : (
          <Card title="4 · ChatGPT (Automation Chrome)">
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>Open <strong>Automation Chrome</strong> and launch the dedicated profile.</li>
              <li>In that window: <Code>chrome://extensions</Code> → Developer mode → Load unpacked → choose the <Code>extension</Code> folder.</li>
              <li>Create a connection key in Settings and paste it into the extension popup. Sign in to ChatGPT yourself.</li>
              <li>If ChatGPT asks for a login or human check, the task pauses and you complete it manually.</li>
            </ol>
          </Card>
        )}
        <Card title="5 · Images (optional)">
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              <strong>Image Template</strong> → choose the website → upload your logo, pick a preset or design your own featured image. The preview is the real output; press <strong>Save templates</strong>.
            </li>
            <li>Body images are clean photo crops unless you start a body template.</li>
            <li>
              On an article&apos;s <strong>Images</strong> tab you can upload your own photos (used first) or mark a collected photo “Don&apos;t use”, then <strong>Regenerate images</strong>.
            </li>
            <li>If no usable image exists the draft continues without it, or waits for review when the website requires images.</li>
          </ol>
        </Card>
        <Card title="6 · Humanizer (editorial polish)">
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              <strong>Editorial Tools → Humanizer</strong>: choose a saved article or paste text, pick all paragraphs or only flagged ones, and run it. Your ChatGPT tab answers in the background.
            </li>
            <li>Every rewrite that changes a number, date, quote, name, link, bold/italic text, the keyword count, the language or the uncertainty keeps the original paragraph; the reason is shown next to it.</li>
            <li>
              <strong>Apply</strong> turns the result into your edited version of the article (the previous version stays in its history). The WordPress draft changes only when you use “Save again”.
            </li>
          </ol>
        </Card>
        <Card title="7 · Plagiarism evidence">
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              <strong>Editorial Tools → Plagiarism Evidence</strong> (or an article’s <strong>Originality</strong> tab): choose a saved article or paste text, pick what to compare with, add URLs if you like, and run the check.
            </li>
            <li>Identical runs of 8+ words and closely matching sentences appear next to their source. Quotations and text that repeats across your own site are listed separately and not counted.</li>
            <li>
              Web search is optional and uses a licensed API: add <Code>SERPER_API_KEY=…</Code> to <Code>.env</Code> and restart. The page never shows a plagiarism percentage — the coverage list tells you what was and wasn’t compared.
            </li>
          </ol>
        </Card>
        <Card title="8 · Bulk campaigns and the workflow">
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              <strong>Bulk Campaigns → New</strong>: paste keywords or load a CSV, check the preview (writer, category, duplicates), fix what it flags and create. One article is queued per ready row. Campaigns never publish.
            </li>
            <li>
              <strong>Writers</strong>: Celebrity, <strong>Celebrity 2</strong> (your own one-prompt celebrity article, with the Celebrity writer’s title step and photos) and Tigram. For a person keyword you choose Celebrity or Celebrity 2. A celebrity article always goes into the website’s <strong>“Celebrity”</strong> category (German websites: <strong>“Prominente”</strong>).
            </li>
            <li>
              <strong>Workflow</strong>: pick a website, add publishing slots in Pakistan time (for example <Code>9:00 AM</Code>), switch it on and add keywords. Articles start ahead of their slot; one that is late moves to the next free slot.
            </li>
            <li>
              Publishing is off until you allow it for the website (with the typed acknowledgement). Until then, workflow articles stay drafts for you to publish. When allowed, the draft is scheduled in WordPress for its slot and checked after it.
            </li>
            <li>
              <strong>Publishing Calendar</strong> shows reserved and free slots for two weeks. “Indexed” is only ever recorded by you after checking Search Console.
            </li>
          </ol>
        </Card>
        {desktop ? (
          <Card title="9 · Updates">
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>The app looks for a new version by itself and downloads it in the background. When it is ready, <strong>Restart to update</strong> appears at the top right (also Help → Check for updates).</li>
              <li>Restarting stops the work safely first: prompts go back to the queue and continue after the restart. An <strong>Updating</strong> window shows each step, then the installer's window shows its progress (it asks nothing) and the new version opens by itself. Your data folder is never touched.</li>
              <li>After an update a notification offers what is new in that version.</li>
            </ol>
          </Card>
        ) : null}
        <Card title="9 · Updates" className={desktop ? 'hidden' : undefined}>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              <strong>Settings → App updates → Check for updates</strong> lists what is new on GitHub; <strong>Update now</strong> stops the app, installs the new version, builds it and starts it again (2–5 minutes). The page shows each step and opens the new version by itself.
            </li>
            <li>It needs the app started with <Code>npm run start:all</Code>. If something fails while installing or building, the version you had starts again.</li>
            <li>The extension (3.5.0 and later) reloads itself from its folder after an update when it is idle; an older one needs one reload in <Code>chrome://extensions</Code>.</li>
          </ol>
        </Card>
        <Card title="10 · Notifications and keyword ideas">
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              <strong>Settings → Notifications</strong>: Windows shows a notification when an article needs review (workflow ones too), ChatGPT is signed out, or a campaign finished. A click opens the page; <strong>Send a test notification</strong> tries it.
            </li>
            <li>
              <strong>Workflow → Keyword ideas</strong>: searches Search Console shows for the website that have no article yet, and Google's related searches / “People also ask” (with <Code>SERPER_API_KEY</Code>). Tick ideas and add them to the queue.
            </li>
          </ol>
        </Card>
        <Card title="Backups & restore">
          <ul className="list-disc space-y-2 pl-5 text-sm">
            <li>
              <strong>Logs / Diagnostics → Back up database + media</strong> writes a consistent copy to the <Code>backups</Code> folder of your data folder
              {desktop ? '.' : <> (or <Code>npm run db:backup -- --media</Code>).</>}
            </li>
            {desktop ? (
              <li>To restore a backup, quit the app and keep the backup folder safe; the Recovery Center lists your recent backups.</li>
            ) : (
              <li>
                Restore: stop the app, then <Code>npm run db:restore -- &lt;folder&gt;</Code>. The current database is moved aside, never deleted.
              </li>
            )}
            <li>Browser profile folders contain your sessions — treat them like passwords and never share them.</li>
          </ul>
        </Card>
        <Card title="Troubleshooting">
          <ul className="list-disc space-y-2 pl-5 text-sm">
            {desktop ? (
              <li>Red “Worker is not running” banner → the app restarts it by itself; if it stays, quit the app from the tray and open it again.</li>
            ) : (
              <li>
                Red “Worker is not running” banner → start <Code>npm run start:all</Code>.
              </li>
            )}
            <li>“Login required” → open the website page and log in again; paused tasks resume.</li>
            <li>Diagnostics → Download diagnostic bundle (secrets removed) when reporting a problem.{desktop ? ' Help → Troubleshooting → Copy details for a report adds the app’s version and log.' : ''}</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
