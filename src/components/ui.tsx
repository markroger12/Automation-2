import Link from 'next/link';
import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, Inbox, TriangleAlert } from 'lucide-react';
import { STATUS_LABELS, statusGroup, type TaskStatus } from '@/lib/domain';

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-[min(100%,280px)] flex-1 basis-0">
        {eyebrow ? <div className="text-muted mb-1 text-xs font-medium uppercase tracking-wide">{eyebrow}</div> : null}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-muted mt-1 max-w-3xl text-sm">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({ children, className, title, description, actions, padded = true }: {
  children?: ReactNode;
  className?: string;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  padded?: boolean;
}) {
  return (
    <section className={cx('surface min-w-0 rounded-xl border', className)}>
      {title || actions ? (
        <header className="border-app flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
          <div className="min-w-[min(100%,240px)] flex-1 basis-0">
            {title ? <h2 className="text-sm font-semibold">{title}</h2> : null}
            {description ? <p className="text-muted mt-0.5 text-xs">{description}</p> : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

const CHIP_TONES = {
  neutral: 'bg-zinc-100 text-zinc-700 ring-zinc-200 dark:bg-white/[0.06] dark:text-zinc-200 dark:ring-white/10',
  info: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/25',
  brand: 'bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-200 dark:ring-indigo-400/30',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/30',
  danger: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/30',
} as const;
export type ChipTone = keyof typeof CHIP_TONES;

export function Chip({ tone = 'neutral', children, title, className }: { tone?: ChipTone; children: ReactNode; title?: string; className?: string }) {
  return (
    <span
      title={title}
      className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset', CHIP_TONES[tone], className)}
    >
      {children}
    </span>
  );
}

export function statusTone(status: string): ChipTone {
  switch (statusGroup(status)) {
    case 'queued':
      return 'neutral';
    case 'running':
      return 'info';
    case 'review':
      return 'warning';
    case 'paused':
      return 'warning';
    case 'draft':
      return status === 'COMPLETED' ? 'success' : 'brand';
    case 'failed':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function StatusChip({ status }: { status: string }) {
  // A step status without a label of its own (e.g. GENERATING_ARTICLE) reads as words.
  const label = STATUS_LABELS[status as TaskStatus] ?? status.replace(/_/g, ' ').toLowerCase();
  return <Chip tone={statusTone(status)}>{label}</Chip>;
}

export function Stat({ label, value, hint, tone, href }: { label: string; value: ReactNode; hint?: ReactNode; tone?: ChipTone; href?: string }) {
  const inner = (
    <div className="surface rounded-xl border px-4 py-3 transition hover:border-[color-mix(in_oklab,var(--text)_35%,transparent)]">
      <div className="text-muted text-xs font-medium">{label}</div>
      <div className={cx('mt-1 text-2xl font-semibold tabular-nums', tone === 'danger' && 'text-rose-600', tone === 'warning' && 'text-amber-600', tone === 'success' && 'text-emerald-600')}>
        {value}
      </div>
      {hint ? <div className="text-muted mt-0.5 text-xs">{hint}</div> : null}
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="text-muted mb-3">{icon ?? <Inbox className="h-8 w-8" aria-hidden />}</div>
      <h3 className="text-sm font-semibold">{title}</h3>
      {description ? <p className="text-muted mt-1 max-w-md text-sm">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Alert({ tone = 'info', title, children, action }: { tone?: 'info' | 'warning' | 'danger' | 'success'; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const styles = {
    info: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/60 dark:text-sky-100',
    warning: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/60 dark:text-amber-100',
    danger: 'border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950/60 dark:text-rose-100',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-100',
  }[tone];
  const Icon = { info: Info, warning: TriangleAlert, danger: CircleAlert, success: CircleCheck }[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('flex gap-3 rounded-lg border px-4 py-3 text-sm', styles)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        {title ? <div className="font-semibold">{title}</div> : null}
        {children ? <div className={title ? 'mt-0.5' : ''}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function KeyValue({ items }: { items: { label: ReactNode; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[minmax(120px,max-content)_1fr] gap-x-4 gap-y-2 text-sm">
      {items.map((item, i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{item.label}</dt>
          <dd className="min-w-0 break-words">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ProgressBar({ value, tone = 'brand', label = 'Progress' }: { value: number; tone?: 'brand' | 'success' | 'danger' | 'warning'; label?: string }) {
  const color = { brand: 'bg-indigo-500', success: 'bg-emerald-500', danger: 'bg-rose-500', warning: 'bg-amber-500' }[tone];
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="surface-2 h-1.5 w-full overflow-hidden rounded-full" role="progressbar" aria-label={label} aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx('h-full rounded-full transition-all', color)} style={{ width: `${v}%` }} />
    </div>
  );
}

export const buttonClasses = (variant: 'primary' | 'secondary' | 'ghost' | 'danger' = 'secondary', size: 'sm' | 'md' | 'icon' = 'md') =>
  cx(
    'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap',
    size === 'sm' ? 'h-8 px-2.5 text-xs' : size === 'icon' ? 'h-8 w-8 shrink-0' : 'h-9 px-3.5 text-sm',
    variant === 'primary' && 'bg-[var(--primary)] text-[var(--primary-fg)] shadow-sm hover:opacity-90',
    variant === 'secondary' && 'surface border hover:bg-[var(--surface-2)]',
    variant === 'ghost' && 'hover:bg-[var(--surface-2)]',
    variant === 'danger' && 'bg-rose-600 text-white hover:bg-rose-700',
  );

export function LinkButton({ href, children, variant = 'secondary', size = 'md' }: { href: string; children: ReactNode; variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' | 'icon' }) {
  return (
    <Link href={href} className={buttonClasses(variant, size)}>
      {children}
    </Link>
  );
}

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function formatRelative(value: Date | string | null | undefined, now: Date = new Date()): string {
  if (!value) return 'never';
  const d = typeof value === 'string' ? new Date(value) : value;
  const diff = Math.round((now.getTime() - d.getTime()) / 1000);
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? 'ago' : 'from now';
  if (abs < 10) return 'just now';
  if (abs < 60) return `${abs}s ${suffix}`;
  if (abs < 3600) return `${Math.round(abs / 60)}m ${suffix}`;
  if (abs < 86400) return `${Math.round(abs / 3600)}h ${suffix}`;
  return `${Math.round(abs / 86400)}d ${suffix}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
