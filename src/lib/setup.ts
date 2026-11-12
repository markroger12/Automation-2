import { db } from './db';
import { getExtensionHealth } from './health';
import { getValue, setValue } from './settings';
import { inDesktopApp } from './runtime';
import { DRAFT_STATUSES, STATUS_LABELS, type TaskStatus } from './domain';
import { assistantSettings } from './assistant/settings';
import { GSC_QUEUE } from './gsc/request-indexing';

/** The owner hid the setup checklist on the Overview (it stays under Logs / Diagnostics → Setup checklist). */
export const SETUP_DISMISSED_KEY = 'setup.dismissed';

export type SetupStepState = 'done' | 'todo' | 'attention' | 'running';

export interface SetupStep {
  key: 'chatgpt' | 'website' | 'article' | 'settings' | 'search-console' | 'assistant';
  title: string;
  detail: string;
  state: SetupStepState;
  optional: boolean;
  /** A page of the dashboard, or a tab of the desktop app. */
  action: { label: string; href?: string; tab?: 'chatgpt' | 'search-console' } | null;
}

export interface SetupState {
  steps: SetupStep[];
  /** The required steps that are done, of all required steps. */
  done: number;
  total: number;
  complete: boolean;
  dismissed: boolean;
}

/** What the checklist reads (all of it measured; nothing assumed). */
export interface SetupFacts {
  desktop: boolean;
  chatgpt: { state: 'connected' | 'stale' | 'never'; tabs: number };
  websites: { id: string; name: string; session: string }[];
  articles: { finished: number; latest: { id: string; keyword: string; status: string } | null };
  settingsSaved: boolean;
  searchConsole: { requested: boolean; waitingForSignIn: boolean };
  assistant: boolean;
  dismissed: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The first-run checklist (owner request 2026-11-12): what is still needed before the first article, from the app's real
 * state. Required: ChatGPT, a website, the first article. Optional: settings, Search Console, the help assistant.
 */
export function setupSteps(f: SetupFacts): SetupState {
  const steps: SetupStep[] = [];

  const chatgptAction = f.desktop ? { label: 'Open the ChatGPT tab', tab: 'chatgpt' as const } : { label: 'Set up Automation Chrome', href: '/automation-chrome' };
  steps.push(
    f.chatgpt.state === 'connected'
      ? { key: 'chatgpt', title: 'Connect ChatGPT', detail: `ChatGPT is connected${f.chatgpt.tabs ? ` (${plural(f.chatgpt.tabs, 'tab')})` : ''}. Articles are written there.`, state: 'done', optional: false, action: null }
      : {
          key: 'chatgpt',
          title: 'Connect ChatGPT',
          detail:
            f.chatgpt.state === 'stale'
              ? 'ChatGPT stopped answering. Open it and check that you are still signed in.'
              : f.desktop
                ? 'Sign in to ChatGPT in the ChatGPT tab at the top (Ctrl+2). The app writes your articles there, in your own account.'
                : 'Open Automation Chrome with the extension and sign in to ChatGPT. The app writes your articles there, in your own account.',
          state: f.chatgpt.state === 'stale' ? 'attention' : 'todo',
          optional: false,
          action: chatgptAction,
        },
  );

  const needsLogin = f.websites.find((w) => w.session === 'LOGIN_REQUIRED');
  const signedIn = f.websites.filter((w) => w.session === 'ACTIVE').length;
  steps.push(
    f.websites.length === 0
      ? {
          key: 'website',
          title: 'Add your WordPress website',
          detail: 'Enter its address, user name and password. The app signs in by itself and saves every article as a draft; nothing is published without your permission.',
          state: 'todo',
          optional: false,
          action: { label: 'Add a website', href: '/websites?add=1' },
        }
      : needsLogin
        ? { key: 'website', title: 'Add your WordPress website', detail: `WordPress asks to sign in again on ${needsLogin.name}.`, state: 'attention', optional: false, action: { label: 'Open the website', href: `/websites/${needsLogin.id}` } }
        : {
            key: 'website',
            title: 'Add your WordPress website',
            detail: `${f.websites.map((w) => w.name).slice(0, 3).join(', ')}${f.websites.length > 3 ? ` and ${f.websites.length - 3} more` : ''}. ${signedIn ? `Signed in to ${plural(signedIn, 'website')}.` : 'The app signs in when it saves the first draft.'}`,
            state: 'done',
            optional: false,
            action: null,
          },
  );

  const latest = f.articles.latest;
  steps.push(
    f.articles.finished > 0
      ? { key: 'article', title: 'Write your first article', detail: `${plural(f.articles.finished, 'article')} finished and saved in WordPress.`, state: 'done', optional: false, action: { label: 'Article History', href: '/history' } }
      : latest
        ? {
            key: 'article',
            title: 'Write your first article',
            detail: `“${latest.keyword}”: ${STATUS_LABELS[latest.status as TaskStatus] ?? latest.status}. Its page shows each step live.`,
            state: latest.status === 'FAILED' || latest.status === 'LOGIN_REQUIRED' || latest.status === 'NEEDS_REVIEW' || latest.status.startsWith('AWAITING') ? 'attention' : 'running',
            optional: false,
            action: { label: 'Open the article', href: `/articles/${latest.id}` },
          }
        : { key: 'article', title: 'Write your first article', detail: 'Type a keyword, choose the website and the writer, and start. It takes a few minutes.', state: 'todo', optional: false, action: { label: 'New article', href: '/single-article' } },
  );

  steps.push({
    key: 'settings',
    title: 'Check the main settings',
    detail: 'How many ChatGPT tabs work at once, how many articles run together, quiet hours, and whether articles wait for your review.',
    state: f.settingsSaved ? 'done' : 'todo',
    optional: true,
    action: { label: 'Open Settings', href: '/settings' },
  });

  steps.push({
    key: 'search-console',
    title: 'Sign in to Search Console',
    detail: f.searchConsole.requested
      ? 'Indexing requests work: the app asks Google to index published articles.'
      : f.searchConsole.waitingForSignIn
        ? 'Indexing requests wait: Search Console asks you to sign in to Google.'
        : 'After an article is published, the app can ask Google to index it. Sign in to Google once.',
    state: f.searchConsole.requested ? 'done' : f.searchConsole.waitingForSignIn ? 'attention' : 'todo',
    optional: true,
    action: f.searchConsole.requested ? null : f.desktop ? { label: 'Open the Search Console tab', tab: 'search-console' } : { label: 'Open Automation Chrome', href: '/automation-chrome' },
  });

  steps.push({
    key: 'assistant',
    title: 'Turn on the help assistant',
    detail: f.assistant ? 'Ask questions about the app with the top bar’s Ask button.' : 'Add a free Gemini API key to ask questions about the app, in English or Roman Urdu.',
    state: f.assistant ? 'done' : 'todo',
    optional: true,
    action: f.assistant ? null : { label: 'Add the key', href: '/settings#assistant' },
  });

  const required = steps.filter((s) => !s.optional);
  const done = required.filter((s) => s.state === 'done').length;
  return { steps, done, total: required.length, complete: done === required.length, dismissed: f.dismissed };
}

export async function setupFacts(): Promise<SetupFacts> {
  const [chatgpt, websites, finished, latest, settingsSaved, gscDone, gscLatest, dismissed] = await Promise.all([
    getExtensionHealth(),
    db.website.findMany({ where: { active: true }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true, wordpressProfile: { select: { sessionState: true } } } }),
    db.articleTask.count({ where: { status: { in: DRAFT_STATUSES } } }),
    db.articleTask.findFirst({ orderBy: { createdAt: 'desc' }, select: { id: true, keyword: true, status: true } }),
    db.auditLog.count({ where: { action: 'settings.update' } }),
    db.queueJob.count({ where: { queue: GSC_QUEUE, status: 'COMPLETED' } }),
    db.queueJob.findFirst({ where: { queue: GSC_QUEUE }, orderBy: { updatedAt: 'desc' }, select: { status: true, errorCode: true } }),
    getValue<boolean>(SETUP_DISMISSED_KEY, false),
  ]);
  return {
    desktop: inDesktopApp(),
    chatgpt: { state: chatgpt.state, tabs: chatgpt.tabs },
    websites: websites.map((w) => ({ id: w.id, name: w.name, session: w.wordpressProfile?.sessionState ?? 'UNKNOWN' })),
    articles: { finished, latest },
    settingsSaved: settingsSaved > 0,
    searchConsole: { requested: gscDone > 0, waitingForSignIn: gscLatest?.status === 'WAITING' && gscLatest.errorCode === 'NOT_SIGNED_IN' },
    assistant: assistantSettings().configured,
    dismissed,
  };
}

export async function setupState(): Promise<SetupState> {
  return setupSteps(await setupFacts());
}

export async function setSetupDismissed(dismissed: boolean): Promise<void> {
  await setValue(SETUP_DISMISSED_KEY, dismissed);
}
