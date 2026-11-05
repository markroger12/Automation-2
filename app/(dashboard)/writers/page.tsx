import Link from 'next/link';
import { ArrowRight, CheckCircle2, CircleAlert, CircleDashed, User, Sparkles } from 'lucide-react';
import { ACTIVE_MODULES } from '@/modules/registry';
import { db } from '@/lib/db';
import { listCustomWriters } from '@/lib/writers/store';
import { Card, Chip, EmptyState, LinkButton, PageHeader, cx, formatDateTime } from '@/components/ui';
import { NewWriterButton, type StartOption } from './new-writer';

export const metadata = { title: 'Writers' };
export const dynamic = 'force-dynamic';

const STATUS: Record<string, { tone: 'success' | 'neutral' | 'warning'; label: string; help: string }> = {
  ACTIVE: { tone: 'success', label: 'active', help: 'Offered everywhere a writer is chosen.' },
  DRAFT: { tone: 'warning', label: 'draft', help: 'Only on its page until you make it active.' },
  ARCHIVED: { tone: 'neutral', label: 'archived', help: 'Hidden from the writer lists; its articles still finish.' },
};

export default async function WritersPage() {
  const [custom, counts] = await Promise.all([listCustomWriters(), db.articleTask.groupBy({ by: ['moduleKey'], _count: { _all: true } })]);
  const legacy = counts.find((c) => c.moduleKey === 'celebrity-writer-2')?._count._all ?? 0;
  const own: StartOption[] = custom.filter((w) => w.status !== 'ARCHIVED').map((w) => ({ id: w.key, title: `Copy of ${w.name}`, kind: w.base, text: 'Its prompts and rules copied.' }));
  return (
    <>
      <PageHeader
        title="Writers"
        description="The built-in writers and your own. Build a writer with your own prompt — no code: start from a writer, paste your prompt, test it with one ChatGPT answer, then make it active."
        actions={
          <>
            <LinkButton href="/single-article">Write a single article</LinkButton>
            <NewWriterButton own={own} />
          </>
        }
      />

      <Card
        className="mb-6"
        title="Your writers"
        description="Active writers appear in Single Article, Workflow, Bulk Campaigns and website routing rules, and run like the built-in ones (same quality gate, drafts only unless the website allows publishing)."
        padded={false}
      >
        {custom.length === 0 ? (
          <EmptyState
            icon={<Sparkles className="h-5 w-5" />}
            title="No writer of your own yet"
            description="Start from Celebrity 2 to keep its steps with your own prompt, or from an empty writer. It stays a draft until you test it and make it active."
            action={<NewWriterButton own={own} />}
          />
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {custom.map((w) => {
              const st = STATUS[w.status] ?? STATUS.DRAFT;
              const test = w.lastTest;
              return (
                <li key={w.key}>
                  <Link href={`/writers/${w.key}`} className="group flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 hover:bg-[var(--surface-2)]">
                    <span className={cx('grid h-9 w-9 shrink-0 place-items-center rounded-lg', w.base === 'person' ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300' : 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300')} aria-hidden>
                      {w.base === 'person' ? <User className="h-4 w-4" /> : <Sparkles className="h-4 w-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{w.name}</span>
                        <Chip tone={st.tone} title={st.help}>
                          {st.label}
                        </Chip>
                        <Chip>{w.base === 'person' ? 'about a person' : 'any topic'}</Chip>
                      </span>
                      <span className="text-muted mt-0.5 block truncate text-xs">{w.description || `Your writer · ${w.key}`}</span>
                    </span>
                    <span className="text-muted flex items-center gap-1.5 text-xs" title={test ? `Last test ${formatDateTime(test.at)}` : 'Not tested yet'}>
                      {test ? test.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" aria-hidden /> : <CircleAlert className="h-3.5 w-3.5 text-amber-500" aria-hidden /> : <CircleDashed className="h-3.5 w-3.5" aria-hidden />}
                      {test ? (test.ok ? `tested · ${test.words} words · ${test.faqs} FAQs` : 'last test found problems') : 'not tested'}
                    </span>
                    <span className="text-muted w-24 text-right text-xs tabular-nums">{w.tasks} article{w.tasks === 1 ? '' : 's'}</span>
                    <ArrowRight className="text-muted h-4 w-4 transition group-hover:translate-x-0.5" aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <h2 className="mb-3 text-sm font-semibold">Built-in writers</h2>
      <div className="grid gap-6 lg:grid-cols-3">
        {ACTIVE_MODULES.map((m) => (
          <Card key={m.key} title={m.name} description={m.description} actions={<Chip tone="success">active</Chip>}>
            <ul className="mb-4 list-disc space-y-1 pl-5 text-sm">
              {m.highlights.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
            <details className="mb-3">
              <summary className="text-muted cursor-pointer text-xs font-semibold uppercase">Steps ({m.stages.length})</summary>
              <ol className="mt-2 flex flex-wrap gap-1.5 text-xs">
                {m.stages.map((s, i) => (
                  <li key={s.key}>
                    <Chip tone={s.kind === 'chatgpt' ? 'brand' : s.kind === 'gate' ? 'warning' : s.kind === 'wordpress' ? 'info' : 'neutral'} title={s.description}>
                      {i + 1}. {s.key}
                    </Chip>
                  </li>
                ))}
              </ol>
            </details>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <NewWriterButton own={own} initial={m.key} label="Use as a start" variant="secondary" size="sm" />
              <Link className="link" href="/prompts">
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
