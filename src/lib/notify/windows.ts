import { spawn } from 'node:child_process';

/**
 * A Windows notification (owner request: “just Windows notification”, no outside service). Windows' own toast, shown
 * through the built-in Windows PowerShell 5.1 (its WinRT notification API; nothing is installed). A click opens the
 * dashboard page in the browser. The text goes in as XML through an environment variable and the script through
 * stdin, so nothing the app writes is ever run as a command.
 */
export interface Toast {
  title: string;
  body: string;
  /** Dashboard page opened by a click, e.g. http://localhost:3000/articles/abc. */
  url: string;
}

/** Windows PowerShell's own app id: its toasts need no app registration. */
export const POWERSHELL_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const xmlText = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

/** The toast XML (ToastGeneric: title, text, “Blog Automation Studio”, an Open button). */
export function toastXml(t: Toast): string {
  const url = xmlText(t.url);
  return (
    `<toast activationType="protocol" launch="${url}">` +
    `<visual><binding template="ToastGeneric"><text>${xmlText(t.title.slice(0, 120))}</text><text>${xmlText(t.body.slice(0, 300))}</text>` +
    `<text placement="attribution">Blog Automation Studio</text></binding></visual>` +
    `<actions><action content="Open" activationType="protocol" arguments="${url}"/></actions></toast>`
  );
}

export const TOAST_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
  '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$xml.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:BAS_TOAST_XML)))',
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:BAS_TOAST_APP).Show((New-Object Windows.UI.Notifications.ToastNotification $xml))',
  '',
].join('\r\n');

/** Show it; on another system nothing happens (shown: false). Never throws. */
export function showToast(t: Toast, platform: NodeJS.Platform = process.platform): Promise<{ shown: boolean; error?: string }> {
  if (platform !== 'win32') return Promise.resolve({ shown: false, error: 'Windows notifications appear on Windows only.' });
  return new Promise((resolve) => {
    let err = '';
    let done = false;
    const finish = (r: { shown: boolean; error?: string }) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
        env: { ...process.env, BAS_TOAST_XML: Buffer.from(toastXml(t), 'utf8').toString('base64'), BAS_TOAST_APP: POWERSHELL_APP_ID },
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      const timer = setTimeout(() => {
        child.kill();
        finish({ shown: false, error: 'Windows PowerShell did not answer within 20 s.' });
      }, 20_000);
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        finish({ shown: false, error: e.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish(code === 0 ? { shown: true } : { shown: false, error: err.trim().slice(0, 300) || `exit code ${code}` });
      });
      child.stdin.end(TOAST_SCRIPT);
    } catch (e) {
      finish({ shown: false, error: (e as Error).message });
    }
  });
}
