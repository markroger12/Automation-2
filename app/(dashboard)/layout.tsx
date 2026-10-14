import Link from 'next/link';
import { Sidebar } from '@/components/sidebar';
import { ToastProvider } from '@/components/client';
import { getHealthWarnings } from '@/lib/health';
import { ensurePragmas } from '@/lib/db';
import { cx } from '@/components/ui';

export const dynamic = 'force-dynamic';

async function HealthBanner() {
  let warnings: Awaited<ReturnType<typeof getHealthWarnings>> = [];
  let dbError: string | null = null;
  try {
    await ensurePragmas();
    warnings = await getHealthWarnings();
  } catch (error) {
    dbError = (error as Error).message;
  }
  if (dbError) {
    return (
      <div className="border-b border-rose-200 bg-rose-50 px-6 py-2 text-sm text-rose-900 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-100" role="alert">
        <strong>Database unavailable.</strong> Run <code>npm run setup</code> to create/migrate data/app.db. ({dbError.slice(0, 200)})
      </div>
    );
  }
  if (warnings.length === 0) return null;
  return (
    <div className="border-app space-y-px border-b">
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

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <div className="lg:flex">
        <Sidebar />
        <div className="min-w-0 flex-1">
          <HealthBanner />
          <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}
