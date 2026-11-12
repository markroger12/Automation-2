import { db } from '../db';
import { getSettings } from '../settings';
import { getExtensionHealth, getWorkerHealth } from '../health';
import { inDesktopApp } from '../runtime';
import { STATUS_LABELS, statusGroup, type TaskStatus } from '../domain';
import { pauseMessage, workPause } from '../work-pause';

/**
 * What the help assistant sends with a question (owner request 2026-11-12): a short picture of this app right now,
 * so the answer fits. Only states, counts, and the short messages the app itself shows; never a password, key,
 * cookie, article text or prompt. The owner can read it in the assistant panel (“Details sent”).
 */
export async function appContext(now = new Date()): Promise<string> {
  const day = new Date(now.getTime() - 24 * 3600_000);
  const [worker, chatgpt, pause, settings, groups, stuck, logs, sites] = await Promise.all([
    getWorkerHealth(now),
    getExtensionHealth(now),
    workPause(now),
    getSettings(),
    db.articleTask.groupBy({ by: ['status'], _count: { _all: true } }),
    db.articleTask.findMany({
      where: { OR: [{ status: { in: ['FAILED', 'NEEDS_REVIEW', 'PAUSED', 'LOGIN_REQUIRED', 'AWAITING_TITLE_APPROVAL', 'AWAITING_ARTICLE_APPROVAL'] } }], updatedAt: { gte: new Date(now.getTime() - 3 * 24 * 3600_000) } },
      orderBy: { updatedAt: 'desc' },
      take: 8,
      select: { keyword: true, status: true, stage: true, message: true, nextAction: true, pausedFor: true, updatedAt: true },
    }),
    db.log.findMany({ where: { level: { in: ['warn', 'error'] }, createdAt: { gte: day } }, orderBy: { createdAt: 'desc' }, take: 12, select: { level: true, category: true, message: true, createdAt: true } }),
    db.website.findMany({ where: { active: true }, select: { name: true, wordpressProfile: { select: { sessionState: true } } }, take: 10 }),
  ]);
  const counts: Record<string, number> = {};
  for (const g of groups) counts[statusGroup(g.status)] = (counts[statusGroup(g.status)] ?? 0) + g._count._all;
  const short = (s: string | null | undefined, n = 180) => (s ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');
  const lines = [
    `App: Blog Automation Studio${inDesktopApp() ? ` desktop app ${process.env.BAS_APP_VERSION ?? ''}`.trimEnd() : ' (npm copy)'}; time ${now.toISOString()}.`,
    `Worker: ${worker.state}. ChatGPT connection: ${chatgpt.state}${chatgpt.state === 'connected' ? ` (${chatgpt.tabs} tab(s))` : ''}.`,
    `New work: ${pause.paused ? pauseMessage(pause) : 'running normally'}.`,
    `Articles: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none yet'}.`,
    `Websites: ${sites.length ? sites.map((s) => `${s.name} (WordPress session ${s.wordpressProfile?.sessionState ?? 'unknown'})`).join('; ') : 'none added yet'}.`,
    `Settings: ChatGPT tabs ${settings.browser.chatgptTabs}; article slots ${settings.workflow.taskConcurrency} (max ${settings.workflow.maxTaskConcurrency}); hold for review ${settings.workflow.holdForReview ? 'on' : 'off'}; quiet hours ${settings.workflow.quietHours ? `${settings.workflow.quietFrom}–${settings.workflow.quietTo}` : 'off'}.`,
  ];
  if (stuck.length) {
    lines.push('Articles that stopped or wait (newest first):');
    for (const t of stuck) lines.push(`- “${short(t.keyword, 80)}”: ${STATUS_LABELS[t.status as TaskStatus] ?? t.status}${t.stage ? ` at ${t.stage}` : ''}${t.pausedFor ? ` (${t.pausedFor})` : ''}. ${short(t.message)} ${t.nextAction ? `Next: ${short(t.nextAction)}` : ''}`.trim());
  }
  if (logs.length) {
    lines.push('Recent warnings and errors (last 24 h, newest first):');
    for (const l of logs) lines.push(`- ${l.createdAt.toISOString().slice(11, 16)} ${l.level} [${l.category}] ${short(l.message)}`);
  }
  return lines.join('\n');
}

/** The assistant's instructions: what the app is, where things are, and how to answer. */
export const ASSISTANT_SYSTEM = `You are the built-in help assistant of "Blog Automation Studio", a Windows program (also usable with npm) that writes blog articles with ChatGPT and saves them as WordPress drafts.
How the app works:
- The worker runs the article steps (research, titles, writing, FAQ, Quick Bio, images, links, Rank Math, WordPress draft). ChatGPT steps run in the app's ChatGPT tabs (desktop app) or in Automation Chrome's extension (npm copy). Settings → ChatGPT tabs sets how many run at once.
- Pages (left menu): Overview, Single Article, Article Queue, Bulk Campaigns, Article History, Writers (own writers, import/export), Websites (add a WordPress site with user name and password; the app logs in itself), Website Control, Prompt Manager, Editorial Tools (Humanizer, Plagiarism Evidence, Research Evidence, Duplicate Review, Content Refresh), Productivity, Search Performance, Workflow / Calendar (keywords per day, publishing slots, indexing requests), Image Template, Settings, Logs / Diagnostics, Recovery Center, Automation Chrome, Help / Setup.
- Desktop app: tabs Dashboard (Ctrl+1), ChatGPT (Ctrl+2), Search Console (Ctrl+3) at the top; Ctrl+K searches pages and quick actions; Alt shows the menus; Help → Check for updates; the tray icon keeps it running. The top bar's Pause button pauses new work; Settings → Workflow has quiet hours.
- Articles are saved as WordPress drafts; publishing needs the website's own publish switch. A sign-in page, a CAPTCHA or a human check is never done by the app: the owner does it, and the article waits and then goes on.
- An article's page has an Overview with a progress timeline, and tabs for titles, research, editor, SEO, links, images, WordPress, stages, prompts and logs. Retry and Regenerate are there.
How to answer:
- Answer in the language and script the owner writes in (for example Roman Urdu or English). Be short and practical: numbered steps that name the exact page, tab or button.
- Use the app's current state below when it explains the question (a stopped article, a disconnected ChatGPT, a paused queue). Say plainly what you see.
- Never ask for or repeat passwords or keys. Never invent features, numbers or settings that are not described here; if you are not sure, say so and point to Help / Setup or Logs / Diagnostics.`;
