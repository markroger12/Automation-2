import Link from 'next/link';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { Card, Chip, EmptyState, PageHeader, buttonClasses, formatDateTime } from '@/components/ui';

export const metadata = { title: 'Logs' };

const PAGE_SIZE = 100;
const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export default async function LogsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const level = LEVELS.includes(sp.level as (typeof LEVELS)[number]) ? sp.level : undefined;
  const category = sp.category?.slice(0, 60) || undefined;
  const q = sp.q?.slice(0, 200) || undefined;
  const taskId = sp.taskId?.slice(0, 40) || undefined;
  const before = sp.before ? new Date(sp.before) : undefined;

  const where: Prisma.LogWhereInput = {
    ...(level ? { level } : {}),
    ...(category ? { category } : {}),
    ...(taskId ? { taskId } : {}),
    ...(q ? { message: { contains: q } } : {}),
    ...(before && !Number.isNaN(before.getTime()) ? { createdAt: { lt: before } } : {}),
  };
  const [rows, categories] = await Promise.all([
    db.log.findMany({ where, orderBy: { createdAt: 'desc' }, take: PAGE_SIZE + 1 }),
    db.log.groupBy({ by: ['category'], _count: { _all: true }, orderBy: { category: 'asc' } }),
  ]);
  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);
  const nextParams = new URLSearchParams({ ...(level ? { level } : {}), ...(category ? { category } : {}), ...(q ? { q } : {}), ...(taskId ? { taskId } : {}) });
  if (hasMore) nextParams.set('before', page[page.length - 1].createdAt.toISOString());

  return (
    <>
      <PageHeader title="Logs" description="Persisted application, worker, extension and browser logs. Secrets are redacted before they are stored." />
      <Card padded={false}>
        <form className="border-app flex flex-wrap items-end gap-3 border-b px-5 py-3" method="get">
          <label className="text-xs">
            <span className="text-muted mb-1 block">Level</span>
            <select name="level" defaultValue={level ?? ''} className="surface rounded-lg border px-2 py-1.5 text-sm">
              <option value="">All</option>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            <span className="text-muted mb-1 block">Category</span>
            <select name="category" defaultValue={category ?? ''} className="surface rounded-lg border px-2 py-1.5 text-sm">
              <option value="">All</option>
              {categories.map((c) => (
                <option key={c.category} value={c.category}>
                  {c.category} ({c._count._all})
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            <span className="text-muted mb-1 block">Task ID</span>
            <input name="taskId" defaultValue={taskId} className="surface w-52 rounded-lg border px-2 py-1.5 text-sm" />
          </label>
          <label className="min-w-[200px] flex-1 text-xs">
            <span className="text-muted mb-1 block">Message contains</span>
            <input name="q" defaultValue={q} className="surface w-full rounded-lg border px-2 py-1.5 text-sm" />
          </label>
          <button className={buttonClasses('primary', 'sm')} type="submit">
            Filter
          </button>
          <Link className={buttonClasses('ghost', 'sm')} href="/logs">
            Reset
          </Link>
        </form>
        {page.length === 0 ? (
          <EmptyState title="No log entries" description="Nothing matches these filters yet." />
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <table className="table-app">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Level</th>
                  <th>Category</th>
                  <th>Message</th>
                  <th>Task / stage</th>
                </tr>
              </thead>
              <tbody>
                {page.map((row) => (
                  <tr key={row.id}>
                    <td className="text-muted whitespace-nowrap font-mono text-xs">{formatDateTime(row.createdAt)}</td>
                    <td>
                      <Chip tone={row.level === 'error' ? 'danger' : row.level === 'warn' ? 'warning' : row.level === 'debug' ? 'neutral' : 'info'}>{row.level}</Chip>
                    </td>
                    <td className="whitespace-nowrap">{row.category}</td>
                    <td className="max-w-[640px]">
                      <div className="break-words">{row.message}</div>
                      {row.details ? (
                        <details className="mt-1">
                          <summary className="text-muted cursor-pointer text-xs">details</summary>
                          <pre className="surface-2 mt-1 max-h-60 overflow-auto rounded p-2 text-[11px] whitespace-pre-wrap">{row.details}</pre>
                        </details>
                      ) : null}
                      {row.screenshotPath ? (
                        <a className="text-xs link" href={`/api/files/screenshot?path=${encodeURIComponent(row.screenshotPath)}`} target="_blank" rel="noreferrer">
                          screenshot
                        </a>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap text-xs">
                      {row.taskId ? (
                        <Link className="link" href={`/articles/${row.taskId}`}>
                          {row.taskId.slice(0, 10)}…
                        </Link>
                      ) : (
                        '—'
                      )}
                      {row.stage ? <div className="text-muted">{row.stage}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {hasMore ? (
          <div className="border-app border-t px-5 py-3">
            <Link className={buttonClasses('secondary', 'sm')} href={`/logs?${nextParams.toString()}`}>
              Older entries →
            </Link>
          </div>
        ) : null}
      </Card>
    </>
  );
}
