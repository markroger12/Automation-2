import { timingSafeEqual } from 'node:crypto';
import { db, type Tx } from '../db';

/**
 * The desktop app's own ChatGPT tab (owner request: “the browser inside the app”). It runs the extension's ChatGPT
 * scripts and talks to this dashboard as an agent with the fixed install id below. Its key is made by the app at each
 * start and handed to the dashboard server in BAS_DESKTOP_AGENT_KEY; it is never stored. While the app is connected,
 * ChatGPT prompts go to it only. Search Console “Request indexing” goes to it too when it says it can (owner,
 * 2026-11-12: Google let the owner sign in in the app's Search Console tab); otherwise it stays with Automation Chrome's
 * extension. The app is never disguised as Chrome.
 */
export const DESKTOP_AGENT_ID = 'desktop-app';
/** The app says hello at least every 20 s; after this long without one, Automation Chrome takes ChatGPT again. */
export const DESKTOP_CONNECTED_MS = 75_000;

export function bearerKey(req: Request): string | null {
  const auth = req.headers.get('authorization') ?? '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
}

/** Whether `presented` is the key the desktop app gave this server at start (constant-time). */
export function isDesktopAgentKey(presented: string | null | undefined): boolean {
  const expected = process.env.BAS_DESKTOP_AGENT_KEY;
  if (!expected || expected.length < 32 || !presented) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The capability the app's agent announces when its Search Console tab makes indexing requests. */
export const SEARCH_CONSOLE_CAPABILITY = 'gsc-request-indexing';

/** Search Console requests are made in the desktop app: its agent is connected, not paused, and says it makes them. */
export async function searchConsoleInApp(now = new Date(), client: Tx = db): Promise<boolean> {
  const row = await client.workerStatus.findUnique({ where: { id: `extension:${DESKTOP_AGENT_ID}` }, select: { lastSeenAt: true, status: true, capabilities: true } });
  if (!row || row.status === 'PAUSED' || now.getTime() - row.lastSeenAt.getTime() > DESKTOP_CONNECTED_MS) return false;
  try {
    return (JSON.parse(row.capabilities) as unknown[]).includes(SEARCH_CONSOLE_CAPABILITY);
  } catch {
    return false;
  }
}

/** ChatGPT runs in the desktop app: its agent said hello recently and is not paused. */
export async function chatgptInApp(now = new Date(), client: Tx = db): Promise<boolean> {
  const row = await client.workerStatus.findUnique({ where: { id: `extension:${DESKTOP_AGENT_ID}` }, select: { lastSeenAt: true, status: true } });
  return Boolean(row && row.status !== 'PAUSED' && now.getTime() - row.lastSeenAt.getTime() <= DESKTOP_CONNECTED_MS);
}
