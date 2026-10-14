import { Card, PageHeader } from '@/components/ui';

export const metadata = { title: 'Help / Setup' };

function Code({ children }: { children: string }) {
  return <code className="surface-2 rounded px-1.5 py-0.5 font-mono text-[13px]">{children}</code>;
}

export default function HelpPage() {
  return (
    <>
      <PageHeader title="Help / Setup" description="Windows-first setup for this private, local tool. Nothing is sent to a cloud service by the app itself." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="1 · Install (once)">
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>Install the latest <strong>Node.js</strong> (v26 or newer) from nodejs.org and <strong>Google Chrome</strong>.</li>
            <li>
              Open <em>PowerShell</em> in the project folder and run <Code>npm install</Code> then <Code>npm run setup</Code>.
            </li>
            <li>Setup creates <Code>data\</Code>, a <Code>.env</Code> (only if missing), migrates the database (with a backup) and seeds default prompts. Running it again is safe.</li>
          </ol>
        </Card>
        <Card title="2 · Start every day">
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              Run <Code>npm run dev:all</Code> (development) or <Code>npm run build</Code> once, then <Code>npm run start:all</Code>.
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
            <li>Click <strong>Log in</strong>: a visible browser window opens; sign in yourself. Passwords are never stored or typed by the app.</li>
            <li>Click <strong>Sync categories</strong>. Drafts are created as drafts only; publishing needs the per-site switch plus the scheduler.</li>
          </ol>
        </Card>
        <Card title="4 · ChatGPT (Automation Chrome)">
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>Open <strong>Automation Chrome</strong> and launch the dedicated profile.</li>
            <li>In that window: <Code>chrome://extensions</Code> → Developer mode → Load unpacked → choose the <Code>extension</Code> folder.</li>
            <li>Create a connection key in Settings and paste it into the extension popup. Sign in to ChatGPT yourself.</li>
            <li>If ChatGPT asks for a login or human check, the task pauses and you complete it manually.</li>
          </ol>
        </Card>
        <Card title="Backups & restore">
          <ul className="list-disc space-y-2 pl-5 text-sm">
            <li>
              <Code>npm run db:backup -- --media</Code> writes a consistent copy to <Code>data\backups\</Code>.
            </li>
            <li>
              Restore: stop the app, then <Code>npm run db:restore -- &lt;folder&gt;</Code>. The current database is moved aside, never deleted.
            </li>
            <li>Browser profile folders contain your sessions — treat them like passwords and never share them.</li>
          </ul>
        </Card>
        <Card title="Troubleshooting">
          <ul className="list-disc space-y-2 pl-5 text-sm">
            <li>Red “Worker is not running” banner → start <Code>npm run dev:all</Code>.</li>
            <li>“Login required” → open the website page and log in again; paused tasks resume.</li>
            <li>Diagnostics → Download diagnostic bundle (secrets removed) when reporting a problem.</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
