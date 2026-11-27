import { db } from '../db';
import { REVIEW_STATUSES } from '../domain';
import { appOrigin } from '../env';
import { log } from '../log';
import { getSettings, getValue, setValue } from '../settings';
import { showToast, type Toast } from './windows';

/**
 * Windows notifications for what needs the owner (owner request): an article that needs review or approval — also
 * from the workflow —, ChatGPT signed out in Automation Chrome, a bulk campaign finished. The worker compares what it
 * sees now with what it already notified (stored in the database), so each event is notified once, and nothing that
 * was already waiting when notifications started.
 */

export interface NotifySnapshot {
  review: { id: string; keyword: string; status: string; source: string; website: string }[];
  campaigns: { id: string; name: string; message: string | null }[];
  chatgptSignedOut: boolean;
}

export interface NotifyState {
  review: string[];
  campaigns: string[];
  chatgptSignedOut: boolean;
}

export interface NotifyOptions {
  review: boolean;
  chatgptSignedOut: boolean;
  campaignFinished: boolean;
}

const STATE_KEY = 'notify.windows.state';
/** More new review articles than this at once: one notification that says how many. */
const ONE_BY_ONE = 3;

const reviewKey = (t: { id: string; status: string }) => `${t.id}:${t.status}`;

/** What is new since the last look (pure). The first look only remembers: nothing that already waited is notified. */
export function newEvents(now: NotifySnapshot, before: NotifyState | null, options: NotifyOptions, origin: string): { toasts: Toast[]; state: NotifyState } {
  const state: NotifyState = { review: now.review.map(reviewKey), campaigns: now.campaigns.map((c) => c.id), chatgptSignedOut: now.chatgptSignedOut };
  if (!before) return { toasts: [], state };
  const toasts: Toast[] = [];
  if (options.review) {
    const fresh = now.review.filter((t) => !before.review.includes(reviewKey(t)));
    if (fresh.length > ONE_BY_ONE) {
      const workflow = fresh.filter((t) => t.source === 'WORKFLOW').length;
      toasts.push({ title: `${fresh.length} articles need your review`, body: `${fresh.slice(0, 3).map((t) => t.keyword).join(', ')}…${workflow ? ` (${workflow} from the workflow)` : ''}`, url: `${origin}/queue?group=review` });
    } else {
      for (const t of fresh) {
        const what = t.status === 'AWAITING_TITLE_APPROVAL' ? 'Title approval needed' : t.status === 'AWAITING_ARTICLE_APPROVAL' ? 'Article approval needed' : 'Article needs review';
        toasts.push({ title: t.source === 'WORKFLOW' ? `Workflow: ${what.toLowerCase()}` : what, body: `${t.keyword} · ${t.website}`, url: `${origin}/articles/${encodeURIComponent(t.id)}` });
      }
    }
  }
  if (options.chatgptSignedOut && now.chatgptSignedOut && !before.chatgptSignedOut) {
    toasts.push({ title: 'ChatGPT is signed out', body: 'Sign in to ChatGPT in Automation Chrome. The articles wait and go on by themselves.', url: `${origin}/automation-chrome` });
  }
  if (options.campaignFinished) {
    for (const c of now.campaigns.filter((c) => !before.campaigns.includes(c.id))) {
      toasts.push({ title: 'Campaign finished', body: `${c.name}${c.message ? `: ${c.message.replace(/^Finished:\s*/, '')}` : ''}`, url: `${origin}/campaigns/${encodeURIComponent(c.id)}` });
    }
  }
  return { toasts, state };
}

export async function notifySnapshot(now = new Date()): Promise<NotifySnapshot> {
  const [review, campaigns, extensions, paused] = await Promise.all([
    db.articleTask.findMany({
      where: { status: { in: REVIEW_STATUSES } },
      select: { id: true, keyword: true, status: true, source: true, website: { select: { name: true } } },
      orderBy: { updatedAt: 'asc' },
      take: 500,
    }),
    // Finished in the last week (older ones were seen long ago).
    db.campaign.findMany({ where: { status: 'COMPLETED', updatedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } }, select: { id: true, name: true, message: true } }),
    db.workerStatus.findMany({ where: { kind: 'EXTENSION', lastSeenAt: { gte: new Date(now.getTime() - 3 * 60_000) } }, select: { diagnostics: true } }),
    db.articleTask.count({ where: { pausedFor: 'chatgpt-login', status: { in: ['LOGIN_REQUIRED', 'PAUSED'] } } }),
  ]);
  const signedOut = extensions.some((e) => {
    try {
      return (JSON.parse(e.diagnostics) as { loggedIn?: boolean | null }).loggedIn === false;
    } catch {
      return false;
    }
  });
  return {
    review: review.map((t) => ({ id: t.id, keyword: t.keyword, status: t.status, source: t.source, website: t.website.name })),
    campaigns,
    chatgptSignedOut: signedOut || paused > 0,
  };
}

let lastFailureLog = 0;

/** One look (worker loop): notify what is new, remember what was seen. */
export async function notifyTick(show: (t: Toast) => Promise<{ shown: boolean; error?: string }> = showToast, now = new Date()): Promise<number> {
  const settings = (await getSettings()).notifications;
  const before = await getValue<NotifyState | null>(STATE_KEY, null);
  const { toasts, state } = newEvents(await notifySnapshot(now), before, settings, appOrigin());
  await setValue(STATE_KEY, state);
  if (!settings.windows) return 0;
  let shown = 0;
  for (const t of toasts) {
    const r = await show(t);
    if (r.shown) shown++;
    else if (r.error && now.getTime() - lastFailureLog > 3600_000 && process.platform === 'win32') {
      lastFailureLog = now.getTime();
      await log({ level: 'warn', category: 'worker', message: `Windows notification not shown (“${t.title}”): ${r.error}` }).catch(() => undefined);
    }
  }
  return shown;
}
