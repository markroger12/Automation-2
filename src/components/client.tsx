'use client';

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, Clipboard, LoaderCircle, Moon, Sun, X } from 'lucide-react';
import { buttonClasses, cx } from './ui';

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  loading,
  className,
  type = 'button',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  loading?: boolean;
}) {
  return (
    <button type={type} {...props} disabled={props.disabled || loading} aria-busy={loading || undefined} className={cx(buttonClasses(variant, size), className)}>
      {loading ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}

/* ---------------- Toasts ---------------- */

type Toast = { id: number; tone: 'success' | 'error' | 'info'; message: string };
const ToastContext = createContext<(tone: Toast['tone'], message: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const push = useCallback((tone: Toast['tone'], message: string) => {
    const id = ++counter.current;
    setToasts((t) => [...t, { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 9000 : 4500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(420px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              'pointer-events-auto flex items-start gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg',
              t.tone === 'success' && 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100',
              t.tone === 'error' && 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-100',
              t.tone === 'info' && 'surface',
            )}
            role={t.tone === 'error' ? 'alert' : 'status'}
          >
            <span className="flex-1">{t.message}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}>
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

/* ---------------- Confirm dialog ---------------- */

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = 'Confirm',
  tone = 'primary',
  onConfirm,
  onCancel,
  busy,
  requireText,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  tone?: 'primary' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  /** When set, the user must type this text to enable the confirm button. */
  requireText?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState('');
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setTyped('');
      dialog.showModal();
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="surface m-auto w-[min(480px,calc(100vw-2rem))] rounded-xl border p-0 text-[var(--text)] shadow-2xl backdrop:bg-black/40"
    >
      <div className="p-5">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        <div className="text-muted mt-2 text-sm">{children}</div>
        {requireText ? (
          <label className="mt-4 block text-sm">
            Type <code className="surface-2 rounded px-1">{requireText}</code> to confirm
            <input
              className="surface mt-1 w-full rounded-lg border px-3 py-2 text-sm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
            />
          </label>
        ) : null}
      </div>
      <div className="border-app flex justify-end gap-2 border-t px-5 py-3">
        <Button onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant={tone === 'danger' ? 'danger' : 'primary'}
          onClick={onConfirm}
          loading={busy}
          disabled={requireText ? typed !== requireText : false}
          autoFocus={!requireText}
        >
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}

/* ---------------- Tabs ---------------- */

export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: ReactNode; badge?: ReactNode }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div role="tablist" className="border-app flex gap-1 overflow-x-auto border-b">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          type="button"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          onKeyDown={(e) => {
            const idx = tabs.findIndex((t) => t.id === value);
            if (e.key === 'ArrowRight') onChange(tabs[(idx + 1) % tabs.length].id);
            if (e.key === 'ArrowLeft') onChange(tabs[(idx - 1 + tabs.length) % tabs.length].id);
          }}
          className={cx(
            '-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition',
            value === tab.id ? 'border-indigo-600 text-indigo-700 dark:text-indigo-300' : 'text-muted border-transparent hover:text-[var(--text)]',
          )}
        >
          {tab.label}
          {tab.badge}
        </button>
      ))}
    </div>
  );
}

/* ---------------- Copy button ---------------- */

export function CopyButton({ text, label = 'Copy', size = 'sm' }: { text: string; label?: string; size?: 'sm' | 'md' }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size={size}
      variant="ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
      aria-label={label}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : label}
    </Button>
  );
}

/* ---------------- Theme toggle ---------------- */

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains('dark')), []);
  return (
    <button
      type="button"
      className={buttonClasses('ghost', 'sm')}
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={() => {
        const next = !dark;
        setDark(next);
        document.documentElement.classList.toggle('dark', next);
        try {
          localStorage.setItem('bas-theme', next ? 'dark' : 'light');
        } catch {
          /* storage unavailable */
        }
      }}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

/* ---------------- Persisted state (filters/sort survive navigation) ---------------- */

export function usePersistentState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(initial);
  const loaded = useRef(false);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(`bas:${key}`);
      if (raw) setValue(JSON.parse(raw) as T);
    } catch {
      /* ignore */
    }
    loaded.current = true;
  }, [key]);
  useEffect(() => {
    if (!loaded.current) return;
    try {
      sessionStorage.setItem(`bas:${key}`, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  }, [key, value]);
  return [value, setValue];
}
