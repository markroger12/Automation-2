'use client';

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, Clipboard, LoaderCircle, Moon, Sun, X } from 'lucide-react';
import { buttonClasses, cx, formatRelative } from './ui';

export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  loading,
  className,
  type = 'button',
  tip,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'icon';
  loading?: boolean;
  /** A short tooltip (and the accessible name when the button shows only an icon). */
  tip?: string;
}) {
  return (
    <button
      type={type}
      aria-label={tip && size === 'icon' ? tip : undefined}
      data-tip={tip}
      {...props}
      disabled={props.disabled || loading}
      aria-busy={loading || undefined}
      className={cx(buttonClasses(variant, size), className)}
    >
      {loading ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden /> : null}
      {loading && size === 'icon' ? null : children}
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

/* ---------------- Dialog ---------------- */

/**
 * A dialog for a form (owner request: settings in a window, as in the reference dashboard, instead of a long page):
 * title and description on top, a body that scrolls, and the buttons at the bottom.
 */
export function Modal({ open, onClose, title, description, children, footer, width = 640 }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      style={{ width: `min(${width}px, calc(100vw - 2rem))` }}
      className="surface m-auto max-h-[min(88vh,900px)] flex-col rounded-xl border p-0 text-[var(--text)] shadow-2xl backdrop:bg-black/50 open:flex"
    >
      <div className="border-app flex items-start justify-between gap-4 border-b px-6 py-4">
        <div className="min-w-0">
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          {description ? <p className="text-muted mt-0.5 text-sm">{description}</p> : null}
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="text-muted -mr-2 rounded-md p-1.5 hover:bg-[var(--surface-2)] hover:text-[var(--text)]">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">{open ? children : null}</div>
      {footer ? <div className="border-app flex flex-wrap items-center justify-end gap-2 border-t px-6 py-3">{footer}</div> : null}
    </dialog>
  );
}

/** A part of a dialog with a small heading (icon and capitals), as “PRICING” / “CONFIGURATION” in the reference. */
export function DialogSection({ icon, title, children }: { icon?: ReactNode; title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-muted mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider">
        {icon}
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/* ---------------- Tabs ---------------- */

export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: ReactNode; badge?: ReactNode }[]; value: string; onChange: (id: string) => void }) {
  return (
    // Tabs wrap to a second row instead of scrolling: a scroll box here showed scrollbars (the active tab's
    // underline sits 1 px below the bar, so even tabs that fit made it scroll vertically).
    <div role="tablist" className="border-app flex flex-wrap gap-x-1 border-b">
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
            value === tab.id ? 'border-[var(--text)] text-[var(--text)]' : 'text-muted border-transparent hover:text-[var(--text)]',
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

/** "12s ago"-style time. Server and browser render it a moment apart, so a small text difference is expected. */
export function RelativeTime({ value }: { value: Date | string | null | undefined }) {
  return <span suppressHydrationWarning>{formatRelative(value)}</span>;
}
