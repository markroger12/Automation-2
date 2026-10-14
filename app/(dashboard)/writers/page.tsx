import Link from 'next/link';
import { ACTIVE_MODULES } from '@/modules/registry';
import { db } from '@/lib/db';
import { Card, Chip, LinkButton, PageHeader } from '@/components/ui';

export const metadata = { title: 'Writers' };

export default async function WritersPage() {
  const counts = await db.articleTask.groupBy({ by: ['moduleKey'], _count: { _all: true } });
  const legacy = counts.find((c) => c.moduleKey === 'celebrity-writer-2')?._count._all ?? 0;
  return (
    <>
      <PageHeader
        title="Writers"
        description="Exactly two active writers. This page is an overview — start an article from Single Article or Bulk Campaigns."
        actions={<LinkButton href="/single-article" variant="primary">Write a single article</LinkButton>}
      />
      <div className="grid gap-6 lg:grid-cols-2">
        {ACTIVE_MODULES.map((m) => (
          <Card key={m.key} title={m.name} description={m.description} actions={<Chip tone="success">active</Chip>}>
            <ul className="mb-4 list-disc space-y-1 pl-5 text-sm">
              {m.highlights.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
            <div className="text-muted mb-2 text-xs font-semibold uppercase">Pipeline ({m.stages.length} stages)</div>
            <ol className="flex flex-wrap gap-1.5 text-xs">
              {m.stages.map((s, i) => (
                <li key={s.key}>
                  <Chip tone={s.kind === 'chatgpt' ? 'brand' : s.kind === 'gate' ? 'warning' : s.kind === 'wordpress' ? 'info' : 'neutral'} title={s.description}>
                    {i + 1}. {s.key}
                  </Chip>
                </li>
              ))}
            </ol>
            <div className="mt-4 flex gap-2 text-sm">
              <Link className="text-indigo-600 hover:underline" href="/prompts">
                Edit prompts →
              </Link>
              <span className="text-muted">· {counts.find((c) => c.moduleKey === m.key)?._count._all ?? 0} article(s)</span>
            </div>
          </Card>
        ))}
      </div>
      <Card className="mt-6" title="Celebrity Writer 2.0 — retired" description="Not selectable, not queueable, not routed to. Historical records stay readable in Article History.">
        <p className="text-sm">{legacy ? `${legacy} historical article(s) remain available read-only.` : 'No historical 2.0 records in this installation.'}</p>
      </Card>
    </>
  );
}
