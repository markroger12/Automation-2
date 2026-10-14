import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { detectBrowsers } from '@/lib/browsers';
import { extensionFolder, isAutomationChromeRunning } from '@/lib/automation-chrome';
import { getExtensionHealth } from '@/lib/health';
import { connectionKeyInfo } from '@/lib/agent/keys';
import { getValue, getSettings } from '@/lib/settings';
import { CLAIMS_PAUSED_KEY } from '@/lib/agent/handler';
import { EXPECTED_EXTENSION_VERSION } from '@/lib/agent/version';
import { getRateState } from '@/lib/chatgpt/rate';
import { dataPaths } from '@/lib/paths';

/** Live status for the five-step Automation Chrome wizard (each step is checked, not assumed). */
export const GET = route({}, async () => {
  const [ext, key, paused, settings, rate, active, waiting, lastLaunch] = await Promise.all([
    getExtensionHealth(),
    connectionKeyInfo(),
    getValue<boolean>(CLAIMS_PAUSED_KEY, false),
    getSettings(),
    getRateState(),
    db.queueJob.count({ where: { queue: 'chatgpt', status: 'ACTIVE' } }),
    db.queueJob.count({ where: { queue: 'chatgpt', status: 'WAITING' } }),
    db.queueJob.findFirst({ where: { queue: 'control', kind: 'chrome.launch' }, orderBy: { createdAt: 'desc' }, select: { status: true, error: true, createdAt: true } }),
  ]);
  const browsers = detectBrowsers();
  const running = isAutomationChromeRunning();
  const diag = ext.diagnostics as { loggedIn?: boolean | null; humanCheck?: boolean | null; lastError?: string | null; tabList?: unknown[] };
  return {
    steps: {
      chromeInstalled: { ok: browsers.some((b) => b.channel === 'chrome'), detail: browsers.map((b) => `${b.name}: ${b.path}`).join(' · ') || 'Not found' },
      chromeRunning: { ok: running.running === true, detail: running.detail },
      extensionLoaded: { ok: ext.installs > 0, detail: ext.installs > 0 ? `Seen ${ext.lastSeenAt?.toISOString() ?? ''}` : 'No extension has contacted the dashboard yet.' },
      paired: { ok: key.configured && ext.state === 'connected', detail: key.configured ? (ext.state === 'connected' ? `Connected (v${ext.version})` : 'Key created; paste it into the extension popup.') : 'No connection key yet.' },
      chatgptSignedIn: { ok: diag.loggedIn === true, detail: diag.loggedIn === true ? 'ChatGPT composer is ready.' : diag.humanCheck ? 'A human check is showing — complete it in Automation Chrome.' : diag.loggedIn === false ? 'ChatGPT shows the login page.' : 'Unknown until a ChatGPT tab is open.' },
    },
    extension: { ...ext, expectedVersion: EXPECTED_EXTENSION_VERSION, versionOk: !ext.version || ext.version === EXPECTED_EXTENSION_VERSION },
    key,
    claimsPaused: paused,
    queue: { active, waiting },
    backoffUntil: rate.backoffUntil,
    concurrency: rate.concurrency,
    tabsSetting: settings.browser.chatgptTabs,
    extensionFolder: extensionFolder(),
    profileFolder: dataPaths.chatgptChrome(),
    lastLaunch,
  };
});
