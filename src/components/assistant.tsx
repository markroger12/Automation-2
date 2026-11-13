'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, Eraser, KeyRound, Loader2, Sparkles, X } from 'lucide-react';
import { api, ApiClientError } from '@/lib/client/api';
import { CopyButton } from './client';
import { cx } from './ui';
import { ErrorBoundary } from './error-boundary';
import { answerBlocks, inlineParts } from '@/lib/assistant/format';

/** Opens the help assistant from anywhere (the search's quick action, the Help page). */
export const OPEN_ASSISTANT_EVENT = 'bas:open-assistant';
/** After an error in the panel: start a fresh conversation, so a saved one cannot bring the error back. */
export const forgetAssistantChat = () => {
  try {
    sessionStorage.removeItem(STORE);
  } catch {
    /* storage unavailable */
  }
};
export const openAssistant = (question?: string) => window.dispatchEvent(new CustomEvent(OPEN_ASSISTANT_EVENT, { detail: { question } }));

interface Turn {
  role: 'user' | 'model';
  text: string;
  error?: boolean;
}
interface Overview {
  settings: { configured: boolean; model: string };
  context: string;
}

const STORE = 'bas-assistant-chat';
const isTurn = (t: unknown): t is Turn => Boolean(t) && typeof t === 'object' && ((t as Turn).role === 'user' || (t as Turn).role === 'model') && typeof (t as Turn).text === 'string';
const SUGGESTIONS = ['Why did my last article stop?', 'ChatGPT is not connected. What should I do?', 'How do I add a new WordPress website?', 'Mera article draft kyun nahi bana?'];

/* ---------------- The answer, from simple Markdown (no HTML from the answer is ever used as HTML) ---------------- */

function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineParts(text).map((part, i) =>
        part.kind === 'bold' ? (
          <strong key={i}>{part.text}</strong>
        ) : part.kind === 'code' ? (
          <code key={i} className="surface-2 rounded px-1 py-0.5 font-mono text-[0.85em]">
            {part.text}
          </code>
        ) : (
          <Fragment key={i}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

function Answer({ text }: { text: string }) {
  const blocks = answerBlocks(text);
  return (
    <div className="space-y-2 leading-relaxed">
      {blocks.map((b, i) =>
        b.kind === 'list' ? (
          b.ordered ? (
            <ol key={i} start={b.start} className="list-decimal space-y-1 pl-5">
              {b.items.map((item, j) => (
                <li key={j}>
                  <Inline text={item.text} />
                  {item.sub.length ? (
                    <ul className="mt-1 list-disc space-y-0.5 pl-5">
                      {item.sub.map((sub, k) => (
                        <li key={k}>
                          <Inline text={sub} />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {b.items.map((item, j) => (
                <li key={j}>
                  <Inline text={item.text} />
                  {item.sub.length ? (
                    <ul className="mt-1 list-[circle] space-y-0.5 pl-5">
                      {item.sub.map((sub, k) => (
                        <li key={k}>
                          <Inline text={sub} />
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )
        ) : b.kind === 'h' ? (
          <p key={i} className="font-semibold">
            <Inline text={b.text} />
          </p>
        ) : (
          <p key={i}>
            <Inline text={b.text} />
          </p>
        ),
      )}
    </div>
  );
}

/** An answer that cannot be shown as formatted text is shown as plain text, never as a broken page. */
function SafeAnswer({ text }: { text: string }) {
  return (
    <ErrorBoundary name="help assistant answer" fallback={() => <p className="whitespace-pre-wrap">{text}</p>}>
      <Answer text={text} />
    </ErrorBoundary>
  );
}

/* ---------------- The panel ---------------- */

/**
 * The help assistant (owner request 2026-11-12, “Gemini Flash krde”): the top bar's “Ask” button opens a panel on the
 * right. A question goes to Google Gemini with the owner's own API key (Settings → Help assistant), together with a
 * short status of the app, which the panel shows under “What the assistant sees”. It answers in the language the
 * question is written in. Nothing here can change a setting or start work: it explains and points to the right page.
 */
export function AssistantButton({ openOnMount = false }: { openOnMount?: boolean }) {
  const [open, setOpen] = useState(openOnMount);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [overview, setOverview] = useState<Overview | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORE) ?? '[]') as unknown;
      if (Array.isArray(saved)) setTurns(saved.filter(isTurn).slice(-20));
    } catch {
      /* storage unavailable */
    }
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem(STORE, JSON.stringify(turns.slice(-20)));
    } catch {
      /* storage unavailable */
    }
  }, [turns]);

  const loadOverview = useCallback(async () => {
    try {
      const o = await api<Overview>('/api/assistant');
      if (o && o.settings && typeof o.context === 'string') setOverview(o);
    } catch {
      /* shown as not set up below; the next opening tries again */
    }
  }, []);

  const ask = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || busy) return;
      // The last 10 turns, each at most 6,000 characters (what the server accepts).
      const history = turns
        .filter((t) => !t.error)
        .slice(-10)
        .map(({ role, text }) => ({ role, text: text.slice(0, 6000) }));
      setTurns((t) => [...t.filter((x) => !x.error), { role: 'user', text: q }]);
      setDraft('');
      setBusy(true);
      try {
        const res = await api<{ answer: string; context: string; model: string }>('/api/assistant', { body: { question: q, history } });
        setTurns((t) => [...t, { role: 'model', text: typeof res?.answer === 'string' && res.answer ? res.answer : 'The assistant sent no answer. Try again.' }]);
        if (typeof res?.context === 'string') setOverview((o) => (o ? { ...o, context: res.context } : o));
      } catch (error) {
        const message = error instanceof ApiClientError ? error.message : 'Something went wrong. Try again.';
        if (error instanceof ApiClientError && error.code === 'ASSISTANT_NOT_SET_UP') void loadOverview();
        setTurns((t) => [...t, { role: 'model', text: message, error: true }]);
      } finally {
        setBusy(false);
      }
    },
    [busy, turns, loadOverview],
  );

  useEffect(() => {
    const onOpen = (e: Event) => {
      setOpen(true);
      const question = (e as CustomEvent<{ question?: string }>).detail?.question;
      if (question) setDraft(question);
    };
    window.addEventListener(OPEN_ASSISTANT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_ASSISTANT_EVENT, onOpen);
  }, []);
  useEffect(() => {
    if (!open) return;
    void loadOverview();
    const timer = setTimeout(() => input.current?.focus(), 50);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, loadOverview]);
  // A block body: in the app's Chromium scrollIntoView() returns a Promise, which React would call as a cleanup.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [turns, busy]);

  const configured = overview?.settings.configured;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="assistant-panel"
        title="Ask the help assistant"
        className={cx('inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors', open ? 'bg-[var(--surface-2)] text-[var(--text)]' : 'text-muted hover:bg-[var(--surface-2)] hover:text-[var(--text)]')}
      >
        <Sparkles className="h-4 w-4" aria-hidden />
        <span className="hidden sm:inline">Ask</span>
      </button>
      {open ? (
        <aside
          id="assistant-panel"
          aria-label="Help assistant"
          className="surface border-app fixed top-0 right-0 bottom-0 z-50 flex w-[min(440px,100vw)] flex-col border-l shadow-2xl"
        >
          <header className="border-app flex items-center gap-3 border-b px-4 py-3">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-[var(--primary)] text-[var(--primary-fg)]">
              <Sparkles className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="text-sm font-semibold">Help assistant</div>
              <div className="text-muted truncate text-xs">{configured ? `Google Gemini · ${overview?.settings.model}` : 'Answers questions about this app'}</div>
            </div>
            {turns.length ? (
              <button type="button" data-tip="New conversation" aria-label="New conversation" onClick={() => setTurns([])} className="text-muted rounded-md p-1.5 hover:bg-[var(--surface-2)] hover:text-[var(--text)]">
                <Eraser className="h-4 w-4" />
              </button>
            ) : null}
            <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="text-muted rounded-md p-1.5 hover:bg-[var(--surface-2)] hover:text-[var(--text)]">
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 text-sm">
            {overview && !configured ? (
              <div className="space-y-3">
                <p className="font-medium">Set up the help assistant once</p>
                <ol className="text-muted list-decimal space-y-1.5 pl-5">
                  <li>
                    Open{' '}
                    <a className="link" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">
                      aistudio.google.com
                    </a>{' '}
                    and sign in with your Google account.
                  </li>
                  <li>Choose Get API key → Create API key, and copy it.</li>
                  <li>Paste it in Settings → Help assistant and press Save. The key is stored encrypted on this PC.</li>
                </ol>
                <Link href="/settings#assistant" onClick={() => setOpen(false)} className="inline-flex items-center gap-1.5 rounded-md bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-[var(--primary-fg)]">
                  <KeyRound className="h-4 w-4" aria-hidden /> Open Settings
                </Link>
              </div>
            ) : turns.length === 0 ? (
              <div className="space-y-3">
                <p className="text-muted">Ask how to do something, or why something stopped. The assistant looks at the app&apos;s current state and answers in your language (English or Roman Urdu).</p>
                <div className="flex flex-col gap-1.5">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} type="button" onClick={() => void ask(s)} disabled={!configured || busy} className="border-app rounded-lg border px-3 py-2 text-left hover:bg-[var(--surface-2)] disabled:opacity-60">
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {turns.map((t, i) =>
              t.role === 'user' ? (
                <div key={i} className="ml-8 rounded-xl rounded-br-sm bg-[var(--primary)] px-3 py-2 whitespace-pre-wrap text-[var(--primary-fg)]">
                  {t.text}
                </div>
              ) : t.error ? (
                <div key={i} role="alert" className="mr-8 rounded-xl rounded-bl-sm border border-rose-300 bg-rose-50 px-3 py-2 text-rose-900 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-100">
                  {t.text}
                </div>
              ) : (
                <div key={i} className="group mr-4">
                  <div className="surface-2 rounded-xl rounded-bl-sm px-3 py-2">
                    <SafeAnswer text={t.text} />
                  </div>
                  <div className="mt-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <CopyButton text={t.text} />
                  </div>
                </div>
              ),
            )}
            {busy ? (
              <p className="text-muted flex items-center gap-2" role="status">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Looking at the app and thinking…
              </p>
            ) : null}
            <div ref={end} />
          </div>

          <form
            className="border-app space-y-2 border-t px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              void ask(draft);
            }}
          >
            <div className="surface border-app flex items-end gap-2 rounded-lg border px-2 py-1.5 focus-within:ring-2 focus-within:ring-[color-mix(in_oklab,var(--text)_12%,transparent)]">
              <textarea
                ref={input}
                rows={2}
                value={draft}
                maxLength={2000}
                disabled={overview ? !configured : false}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void ask(draft);
                  }
                }}
                placeholder={configured === false ? 'Add your Gemini API key in Settings first' : 'Ask a question… (Enter sends, Shift+Enter for a new line)'}
                aria-label="Your question"
                className="max-h-40 min-h-[2.5rem] w-full resize-none bg-transparent text-sm outline-none placeholder:text-[var(--text-muted)]"
              />
              <button type="submit" aria-label="Send" disabled={!draft.trim() || busy || !configured} className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-[var(--primary)] text-[var(--primary-fg)] disabled:opacity-40">
                <ArrowUp className="h-4 w-4" />
              </button>
            </div>
            <details className="text-muted text-xs">
              <summary className="cursor-pointer select-none">What the assistant sees</summary>
              <p className="mt-1.5">Your question and this short status of the app go to Google Gemini. Passwords, keys, cookies and article texts are never sent.</p>
              <pre className="surface-2 mt-1.5 max-h-48 overflow-auto rounded-md p-2 font-mono text-[11px] whitespace-pre-wrap">{overview?.context ?? 'Loading…'}</pre>
            </details>
          </form>
        </aside>
      ) : null}
    </>
  );
}

/** A page button that opens the help assistant (Help / Setup). */
export function AskAssistantButton() {
  return (
    <button type="button" onClick={() => openAssistant()} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--primary)] px-3 text-sm font-medium text-[var(--primary-fg)] hover:opacity-90">
      <Sparkles className="h-4 w-4" aria-hidden /> Ask the help assistant
    </button>
  );
}
