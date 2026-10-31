import Link from 'next/link';
import { Shell } from '@/components/sidebar';
import { ToastProvider } from '@/components/client';
import { getHealthWarnings, type HealthWarning } from '@/lib/health';
import { ensurePragmas } from '@/lib/db';
import { cx } from '@/components/ui';

export const dynamic = 'force-dynamic';

async function loadHealth(): Promise<{ warnings: HealthWarning[]; dbError: string | null }> {
  try {
    await ensurePragmas();
    return { warnings: await getHealthWarnings(), dbError: null };
  } catch (error) {
    return { warnings: [], dbError: (error as Error).message };
  }
}

function HealthBanner({ warnings, dbError }: { warnings: HealthWarning[]; dbError: string | null }) {
  if (dbError) {
    return (
      <div className="border-b border-rose-200 bg-rose-50 px-6 py-2 text-sm text-rose-900 lg:rounded-t-xl dark:border-rose-900 dark:bg-rose-950 dark:text-rose-100" role="alert">
        <strong>Database unavailable.</strong> Run <code>npm run setup</code> to create/migrate data/app.db. ({dbError.slice(0, 200)})
      </div>
    );
  }
  if (warnings.length === 0) return null;
  return (
    <div className="border-app space-y-px overflow-clip border-b lg:rounded-t-xl">
      {warnings.slice(0, 3).map((w, i) => (
        <div
          key={i}
          className={cx(
            'flex flex-wrap items-center gap-x-3 gap-y-1 px-6 py-1.5 text-[13px]',
            w.tone === 'danger' && 'bg-rose-50 text-rose-900 dark:bg-rose-950/70 dark:text-rose-100',
            w.tone === 'warning' && 'bg-amber-50 text-amber-900 dark:bg-amber-950/70 dark:text-amber-100',
            w.tone === 'info' && 'bg-sky-50 text-sky-900 dark:bg-sky-950/70 dark:text-sky-100',
          )}
          role={w.tone === 'danger' ? 'alert' : 'status'}
        >
          <strong>{w.title}.</strong>
          <span className="opacity-90">{w.detail}</span>
          {w.href ? (
            <Link href={w.href} className="ml-auto font-semibold underline underline-offset-2">
              {w.action ?? 'Fix'}
            </Link>
          ) : null}
        </div>
      ))}
      {warnings.length > 3 ? <div className="text-muted px-6 py-1 text-xs">+{warnings.length - 3} more on the Overview page</div> : null}
    </div>
  );
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const health = await loadHealth();
  const notices = health.dbError ? [{ tone: 'danger' as const, title: 'Database unavailable', detail: 'Run npm run setup to create/migrate data/app.db.' }] : health.warnings;
  return (
    <ToastProvider>
      <Shell notices={notices}>
        <HealthBanner {...health} />
        <main className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </Shell>
    </ToastProvider>
  );
}
