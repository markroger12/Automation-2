'use client';

import { useState } from 'react';
import { ExternalLink, MessageSquare } from 'lucide-react';
import type { SerializedTaskDetail } from '@/lib/tasks/detail';
import { Card, Chip, KeyValue, cx, formatDateTime, formatDuration, type ChipTone } from '@/components/ui';
import { LANGUAGE_LABELS, type Language } from '@/lib/domain';
import { QualityCard } from './quality-card';

const SOURCE_LABEL: Record<string, string> = { SINGLE: 'Single Article', BULK: 'Bulk campaign', WORKFLOW: 'Workflow', BENCHMARK: 'Benchmark', REFRESH: 'Content refresh' };

/** The article's options as words (they were shown as raw JSON). Unknown keys are still listed, never hidden. */
export function optionLabels(opts: Record<string, unknown>): { label: string; title?: string }[] {
  const out: { label: string; title?: string }[] = [];
  const onOff = (v: unknown) => (v ? 'on' : 'off');
  for (const [key, v] of Object.entries(opts)) {
    if (v === undefined || v === null) continue;
    switch (key) {
      case 'images':
        out.push({ label: v === 'site' ? 'Images: website setting' : `Images: ${v}` });
        break;
      case 'saveToWordPress':
        out.push({ label: v ? 'Saved to WordPress as a draft' : 'Not saved to WordPress' });
        break;
      case 'externalLinks':
        out.push({ label: `External links: ${onOff(v)}` });
        break;
      case 'internalLinks':
        out.push({ label: `Internal link: ${onOff(v)}` });
        break;
      case 'manualTitleApproval':
        out.push({ label: v ? 'You approve the title' : 'Title chosen automatically' });
        break;
      case 'manualArticleApproval':
        out.push({ label: v ? 'You approve the article' : 'Article approved automatically' });
        break;
      case 'holdForReview':
        out.push({ label: `Review hold: ${onOff(v)}` });
        break;
      case 'maxWords':
        out.push({ label: `Up to ${v} words` });
        break;
      case 'faqCount':
        out.push({ label: `${v} FAQs` });
        break;
      case 'quickBioRows':
        out.push({ label: `Quick Bio: ${v} rows` });
        break;
      case 'reviewThreshold':
        out.push({ label: `Review below ${v}` });
        break;
      case 'rankMathTargetScore':
        out.push({ label: `Rank Math target ${v}` });
        break;
      case 'publishForced':
        out.push({ label: 'Force continue: published despite problems', title: JSON.stringify(v) });
        break;
      case 'publishBlocked':
        out.push({ label: 'Not published automatically (problems found)', title: Array.isArray(v) ? v.join('\n') : JSON.stringify(v) });
        break;
      case 'duplicateOverride':
        out.push({ label: 'Duplicate allowed by you', title: JSON.stringify(v) });
        break;
      default: {
        const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
        const simple = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
        out.push(simple ? { label: `${words}: ${String(v)}` } : { label: words, title: JSON.stringify(v) });
      }
    }
  }
  return out;
}

function KeywordChips({ list }: { list: string[] }) {
  const [all, setAll] = useState(false);
  if (!list.length) return <span className="text-muted">—</span>;
  const shown = all ? list : list.slice(0, 8);
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((k, i) => (
        <span key={`${k}-${i}`} className="surface-2 border-app rounded-md border px-2 py-0.5 text-xs">
          {k}
        </span>
      ))}
      {list.length > 8 ? (
        <button type="button" className="link text-xs" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `+${list.length - 8} more`}
        </button>
      ) : null}
    </div>
  );
}

function LongText({ text, limit = 180 }: { text: string; limit?: number }) {
  const [open, setOpen] = useState(false);
  if (text.length <= limit) return <>{text}</>;
  return (
    <>
      {open ? text : `${text.slice(0, limit).trimEnd()}…`}{' '}
      <button type="button" className="link text-xs" onClick={() => setOpen((v) => !v)}>
        {open ? 'less' : 'more'}
      </button>
    </>
  );
}

const scoreTone = (n: number): ChipTone => (n >= 80 ? 'success' : n >= 60 ? 'warning' : 'danger');
const INCIDENT_STATUS: Record<string, { label: string; tone: ChipTone }> = {
  OPEN: { label: 'open', tone: 'warning' },
  AUTO_RESOLVED: { label: 'resolved automatically', tone: 'success' },
  RESOLVED: { label: 'resolved', tone: 'success' },
  DISMISSED: { label: 'dismissed', tone: 'neutral' },
};
const words = (code: string) => code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');

/** Article → Overview: what was asked, what came out, when, and what went wrong (owner request: a cleaner page). */
export function OverviewTab({ task, onTab }: { task: SerializedTaskDetail; onTab?: (tab: string) => void }) {
  const opts = optionLabels(task.optionValues as Record<string, unknown>);
  const steps = [
    { label: 'Created', at: task.createdAt },
    { label: 'Started', at: task.startedAt },
    { label: 'Draft saved in WordPress', at: task.wpDraftAt },
    { label: 'Completed', at: task.completedAt },
  ];
  const ms = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : null);
  const startMs = ms(task.startedAt);
  const doneMs = ms(task.completedAt);
  const issues = task.incidents.length + task.errorList.length;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="lg:col-span-2">
        <QualityCard taskId={task.id} onTab={onTab} />
      </div>

      <Card title="Input" description="As submitted">
        <KeyValue
          items={[
            { label: 'Primary keyword', value: <span className="font-medium">{task.keyword}</span> },
            { label: `Secondary keywords${task.secondaryKeywordList.length ? ` (${task.secondaryKeywordList.length})` : ''}`, value: <KeywordChips list={task.secondaryKeywordList} /> },
            { label: 'Example title', value: task.exampleTitle ?? <span className="text-muted">—</span> },
            { label: 'Writer', value: task.writerName },
            { label: 'Website', value: task.website.name },
            { label: 'Category', value: task.categoryName ?? <span className="text-muted">not chosen yet</span> },
            { label: 'Language / country', value: `${LANGUAGE_LABELS[task.language as Language] ?? task.language} · ${task.targetCountry}` },
            { label: 'Source', value: SOURCE_LABEL[task.source] ?? task.source },
            {
              label: 'Options',
              value: opts.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {opts.map((o) => (
                    <Chip key={o.label} title={o.title}>
                      {o.label}
                    </Chip>
                  ))}
                </div>
              ) : (
                <span className="text-muted">website defaults</span>
              ),
            },
          ]}
        />
      </Card>

      <Card title="Result">
        <KeyValue
          items={[
            { label: 'Title', value: task.selectedTitle ? <span className="font-medium">{task.selectedTitle}</span> : <span className="text-muted">not chosen yet</span> },
            { label: 'SEO title', value: !task.seoTitle ? <span className="text-muted">—</span> : task.seoTitle === task.selectedTitle ? <span className="text-muted">same as the title</span> : task.seoTitle },
            {
              label: 'Meta description',
              value: task.metaDescription ? (
                <>
                  {task.metaDescription}
                  <span className="text-muted block text-xs">{task.metaDescription.length} characters</span>
                </>
              ) : (
                <span className="text-muted">—</span>
              ),
            },
            { label: 'Slug', value: task.slug ? <code className="text-xs">{task.slug}</code> : <span className="text-muted">—</span> },
            { label: 'Focus keyword', value: task.focusKeyword ?? <span className="text-muted">—</span> },
            {
              label: 'Scores',
              value: (
                <div className="flex flex-wrap items-center gap-1.5">
                  {task.seoScore !== null ? <Chip tone={scoreTone(task.seoScore)}>Internal SEO {task.seoScore} / 100</Chip> : <Chip>Internal SEO —</Chip>}
                  {task.rankMathScore !== null ? (
                    <Chip tone={scoreTone(task.rankMathScore)} title="Read from WordPress">
                      Rank Math {task.rankMathScore} / 100
                    </Chip>
                  ) : (
                    <Chip title="The Rank Math score is only read from WordPress, never estimated">Rank Math not verified</Chip>
                  )}
                </div>
              ),
            },
            {
              label: 'WordPress',
              value: task.wpEditUrl ? (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <a className="link inline-flex items-center gap-1" href={task.wpEditUrl} target="_blank" rel="noreferrer">
                    Post #{task.wpPostId} <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                  <Chip tone={task.wpPostStatus === 'publish' ? 'success' : task.wpPostStatus === 'future' ? 'brand' : 'neutral'}>{task.wpPostStatus ?? 'draft'}</Chip>
                </span>
              ) : (
                <span className="text-muted">not saved yet</span>
              ),
            },
            { label: 'Verified complete', value: task.verifiedCompleteAt ? formatDateTime(task.verifiedCompleteAt) : <span className="text-muted">not yet</span> },
          ]}
        />
      </Card>

      <Card
        title="Timeline"
        description={startMs && doneMs ? `${formatDuration(doneMs - startMs)} from start to finish` : undefined}
        actions={
          task.conversationUrl ? (
            <a className="link inline-flex items-center gap-1 text-sm" href={task.conversationUrl} target="_blank" rel="noreferrer">
              <MessageSquare className="h-3.5 w-3.5" aria-hidden /> ChatGPT conversation
            </a>
          ) : undefined
        }
      >
        <ol className="border-app ml-1.5 border-l">
          {steps.map((s, i) => {
            const prev = steps.slice(0, i).reverse().find((p) => p.at);
            const gap = s.at && prev?.at ? ms(s.at)! - ms(prev.at)! : null;
            return (
              <li key={s.label} className="relative pb-4 pl-5 last:pb-0">
                <span className={cx('absolute top-1 -left-[7px] h-3 w-3 rounded-full border-2', s.at ? 'border-emerald-500 bg-emerald-500' : 'border-app bg-[var(--surface)]')} aria-hidden />
                <div className={cx('text-sm font-medium', !s.at && 'text-muted')}>{s.label}</div>
                <div className="text-muted text-xs">
                  {s.at ? formatDateTime(s.at) : 'not yet'}
                  {gap !== null && gap >= 60_000 ? ` · ${formatDuration(gap)} later` : ''}
                </div>
              </li>
            );
          })}
        </ol>
      </Card>

      <Card title="Errors & incidents" description={issues ? `${issues} recorded` : undefined}>
        {issues === 0 ? (
          <p className="text-muted text-sm">No errors recorded.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)] text-sm">
            {task.incidents.map((i) => {
              const st = INCIDENT_STATUS[i.status] ?? { label: i.status.toLowerCase(), tone: 'neutral' as ChipTone };
              return (
                <li key={i.id} className="py-2.5 first:pt-0 last:pb-0">
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <Chip tone={i.status === 'OPEN' ? 'warning' : 'neutral'}>{words(i.kind)}</Chip>
                    <Chip tone={st.tone}>{st.label}</Chip>
                    <span className="text-muted text-xs">{formatDateTime(i.createdAt)}</span>
                  </div>
                  <p className="break-words">
                    <LongText text={i.description} />
                  </p>
                </li>
              );
            })}
            {task.errorList
              .slice()
              .reverse()
              .map((e, n) => (
                <li key={n} className="py-2.5 first:pt-0 last:pb-0">
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <Chip tone="danger">error</Chip>
                    {e.stage ? <code className="text-muted text-xs">{e.stage}</code> : null}
                    <span className="text-muted text-xs">{formatDateTime(e.at)}</span>
                  </div>
                  <p className="break-words text-rose-700 dark:text-rose-300">
                    <LongText text={e.message} />
                  </p>
                </li>
              ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
