import Link from 'next/link';
import { BookCheck, Copy, RefreshCcw, ScanSearch, Sparkles } from 'lucide-react';
import { db } from '@/lib/db';
import { Card, Chip, PageHeader, formatRelative } from '@/components/ui';
import { RunStatusChip } from '@/components/humanizer-results';
import { SOON_ROUTES } from '@/components/nav-config';

export const metadata = { title: 'Editorial Tools' };

const TOOLS = [
  { href: '/humanizer', title: 'Humanizer', icon: Sparkles, text: 'Paragraph-level editorial polish with fact locks, side by side, for a saved article or pasted text.', milestone: 'M9' },
  { href: '/plagiarism', title: 'Plagiarism Evidence', icon: ScanSearch, text: 'Matching passages with their sources — evidence, never a verdict from a percentage.', milestone: 'M11' },
  { href: '/duplicates', title: 'Duplicate Review', icon: Copy, text: 'Cross-website similarity review before drafts go out.', milestone: 'M12' },
  { href: '/research-evidence', title: 'Research Evidence', icon: BookCheck, text: 'Claim/evidence ledger with contradictions and source freshness.', milestone: 'M13' },
  { href: '/content-refresh', title: 'Content Refresh', icon: RefreshCcw, text: 'Reviewable refresh candidates and revisions for published posts.', milestone: 'M15' },
];

/** Editorial tools hub plus the latest editorial history (humanizer runs and owner edits). */
export default async function EditorialPage() {
  const [runs, edits] = await Promise.all([
    db.humanizerRun.findMany({ orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, title: true, status: true, source: true, appliedAt: true, createdAt: true } }),
    db.articleStageRevision.findMany({ where: { key: { in: ['EDITOR', 'HUMANIZER'] } }, orderBy: { createdAt: 'desc' }, take: 10, select: { id: true, taskId: true, key: true, reason: true, createdAt: true } }),
  ]);
  const keywords = new Map((await db.articleTask.findMany({ where: { id: { in: edits.map((e) => e.taskId) } }, select: { id: true, keyword: true } })).map((t) => [t.id, t.keyword]));
  return (
    <>
      <PageHeader title="Editorial Tools" description="Tools that help you check and improve articles. None of them publishes anything or changes a WordPress draft without your explicit action." />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {TOOLS.map((t) => {
          const soon = SOON_ROUTES.has(t.href);
          const Icon = t.icon;
          return (
            <Card key={t.href} title={<span className="flex items-center gap-2"><Icon className="h-4 w-4" /> {t.title}</span>} actions={soon ? <Chip>coming in {t.milestone}</Chip> : <Chip tone="success">available</Chip>}>
              <p className="text-sm">{t.text}</p>
              {!soon ? (
                <Link href={t.href} className="mt-3 inline-block text-sm font-medium link">
                  Open {t.title}
                </Link>
              ) : null}
            </Card>
          );
        })}
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Recent humanizer runs">
          {runs.length === 0 ? <p className="text-muted text-sm">No runs yet.</p> : null}
          <ul className="space-y-2 text-sm">
            {runs.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2">
                <Link href={`/humanizer?run=${r.id}`} className="truncate link">
                  {r.title}
                </Link>
                <span className="flex shrink-0 items-center gap-2">
                  {r.appliedAt ? <Chip tone="success">applied</Chip> : null}
                  <RunStatusChip status={r.status} />
                  <span className="text-muted text-xs">{formatRelative(r.createdAt)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Editorial history" description="Earlier versions kept when you edited an article or applied a humanizer run.">
          {edits.length === 0 ? <p className="text-muted text-sm">No edits yet.</p> : null}
          <ul className="space-y-2 text-sm">
            {edits.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-2">
                <Link href={`/articles/${e.taskId}?tab=editor`} className="truncate link">
                  {keywords.get(e.taskId) ?? 'Article'}
                </Link>
                <span className="text-muted shrink-0 text-xs">
                  {e.key === 'HUMANIZER' ? 'humanizer applied' : e.reason} · {formatRelative(e.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
