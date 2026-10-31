'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { OctagonX, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/client/api';
import { groupReviewNotes } from '@/lib/review-notes';
import { Card, Chip, cx, formatDateTime, type ChipTone } from '@/components/ui';
import { DuplicateMatchCard, type DuplicateMatchView } from '@/components/duplicate-match';
import type { QualitySections } from '@/lib/quality/report';
import { NoteGroups } from './review-notes';

interface Finding {
  code: string;
  message: string;
  source: string;
}
interface Report {
  stage: string;
  status: 'PASS' | 'REVIEW' | 'BLOCKED';
  createdAt: string;
  hardStops: Finding[];
  warnings: Finding[];
  sections: QualitySections;
}

const STATUS: Record<Report['status'], { tone: ChipTone; label: string }> = {
  PASS: { tone: 'success', label: 'passed' },
  REVIEW: { tone: 'warning', label: 'needs review' },
  BLOCKED: { tone: 'danger', label: 'stopped before WordPress' },
};

const FIRST_WARNINGS = 4;

/** Findings as notes (the same parser as the article's Notes): short title, quote, details on click. */
const asGroups = (items: Finding[]) => groupReviewNotes(items.map((f) => `${f.message} [${f.source}]`));

function Check({ label, value, tone }: { label: string; value: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="border-app rounded-lg border px-3 py-2">
      <div className="text-muted flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider">
        {tone ? <span className={cx('h-1.5 w-1.5 rounded-full', tone === 'ok' ? 'bg-emerald-500' : tone === 'warn' ? 'bg-amber-500' : 'bg-rose-500')} aria-hidden /> : null}
        {label}
      </div>
      <div className="mt-0.5 text-sm break-words">{value}</div>
    </div>
  );
}

/**
 * The latest ArticleQualityReport: what stopped or flagged the article, and the evidence per area. Owner request
 * (screenshot: a wall of long warnings with “RESEARCH_EVIDENCE” links): hard stops in their own box, warnings grouped
 * by where they come from with a short line each (details on click), the first few then “Show all”, and the checks
 * as small tiles.
 */
export function QualityCard({ taskId, onTab }: { taskId: string; onTab?: (tab: string) => void }) {
  const [data, setData] = useState<{ report: Report | null; duplicates: DuplicateMatchView[] } | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    void api<{ report: Report | null; duplicates: DuplicateMatchView[] }>(`/api/tasks/${taskId}/quality`).then(setData).catch(() => setData({ report: null, duplicates: [] }));
  }, [taskId]);
  if (!data) return <Card title="Quality report"><p className="text-muted text-sm">Loading…</p></Card>;
  const r = data.report;
  if (!r) return <Card title="Quality report"><p className="text-muted text-sm">Not evaluated yet — the quality gate runs after the SEO check.</p></Card>;
  const s = r.sections;
  const shown = data.duplicates.filter((d) => d.severity !== 'LOW');
  const stops = asGroups(r.hardStops);
  const warnings = asGroups(r.warnings);
  const checks: { label: string; value: ReactNode; tone?: 'ok' | 'warn' | 'bad' }[] = [];
  if (s.seo) checks.push({ label: 'SEO readiness', tone: s.seo.score >= s.seo.threshold ? 'ok' : 'warn', value: <>{s.seo.score}/100 <span className="text-muted text-xs">(review below {s.seo.threshold})</span>{s.seo.failed.length ? <span className="text-muted block text-xs">not met: {s.seo.failed.slice(0, 4).join('; ')}</span> : null}</> });
  if (s.structure) {
    const st = s.structure;
    const extra = [st.quickBioRows !== null ? `Quick Bio ${st.quickBioRows} rows${st.quickBioColumnsOk === false ? ' (malformed)' : ''}` : null, st.emptyHeadings ? `${st.emptyHeadings} empty heading(s)` : null, st.duplicateSentences ? `${st.duplicateSentences} repeated sentence(s)` : null].filter(Boolean);
    checks.push({ label: 'Structure', tone: st.faqCount === st.expectedFaqCount && !st.emptyHeadings && st.quickBioColumnsOk !== false ? 'ok' : 'warn', value: <>{st.words.toLocaleString('en-US')} words · {st.faqCount}/{st.expectedFaqCount} FAQs{extra.length ? <span className="text-muted block text-xs">{extra.join(' · ')}</span> : null}</> });
  }
  if (s.evidence) checks.push({ label: 'Research evidence', tone: s.evidence.sources ? 'ok' : 'warn', value: <>{s.evidence.sources} source URL(s)<span className="text-muted block text-xs">{s.evidence.uncertain} uncertainty note(s)</span></> });
  if (s.duplicates)
    checks.push({
      label: 'Duplicates',
      tone: !s.duplicates.highest || s.duplicates.highest === 'LOW' ? 'ok' : s.duplicates.overridden ? 'warn' : 'bad',
      value: s.duplicates.highest ? <>{s.duplicates.highest.toLowerCase()} overlap{s.duplicates.overridden ? <span className="text-muted block text-xs">kept by you (“{s.duplicates.overrideReason}”)</span> : null}<span className="text-muted block text-xs">{s.duplicates.compared} compared</span></> : <>no overlap<span className="text-muted block text-xs">{s.duplicates.compared} saved article(s) compared</span></>,
    });
  if (s.links) checks.push({ label: 'Links', tone: s.links.internalLinkLine ? 'ok' : 'warn', value: <>{s.links.external} external<span className="text-muted block text-xs">internal link line {s.links.internalLinkLine ? 'present' : 'missing'}</span></> });
  if (s.images) checks.push({ label: 'Images', tone: s.images.count >= 3 ? 'ok' : s.images.required && !s.images.count ? 'bad' : 'warn', value: <>{s.images.count} image(s)<span className="text-muted block text-xs">{s.images.withAlt} with alt text{s.images.required ? ' · required for this site' : ''}</span></> });
  if (s.rankMath) checks.push({ label: 'Rank Math', tone: s.rankMath.active === false ? undefined : s.rankMath.fieldsVerified ? 'ok' : 'warn', value: s.rankMath.active === false ? 'not active on this site' : <>{s.rankMath.score !== null ? `score ${s.rankMath.score}` : 'no score shown'}{s.rankMath.scoreVia ? ` via ${s.rankMath.scoreVia}` : ''}<span className="text-muted block text-xs">fields {s.rankMath.fieldsVerified ? 'verified' : 'not verified'} (read from the editor)</span></> });
  if (s.wordpress) checks.push({ label: 'WordPress', tone: s.wordpress.verified ? 'ok' : 'warn', value: s.wordpress.verified ? <>draft #{s.wordpress.postId} verified<span className="text-muted block text-xs">{s.wordpress.status}</span></> : 'no verified draft' });
  return (
    <Card
      padded={false}
      title="Quality report"
      description={`${r.stage === 'VERIFIED_COMPLETE' ? 'Final check after the WordPress draft' : 'Quality gate'} · ${formatDateTime(r.createdAt)}`}
      actions={<Chip tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Chip>}
    >
      <div className="border-app flex flex-wrap items-center gap-2 border-b px-4 py-2.5 text-sm">
        {r.hardStops.length ? <Chip tone="danger">{r.hardStops.length} hard stop{r.hardStops.length === 1 ? '' : 's'}</Chip> : null}
        {r.warnings.length ? <Chip tone="warning">{r.warnings.length} warning{r.warnings.length === 1 ? '' : 's'}</Chip> : null}
        {!r.hardStops.length && !r.warnings.length ? <Chip tone="success">All checks passed</Chip> : null}
        <span className="text-muted text-xs">{[...stops, ...warnings].reduce<string[]>((acc, g) => (acc.includes(g.label) ? acc : [...acc, g.label]), []).join(' · ')}</span>
      </div>
      {r.hardStops.length ? (
        <section aria-label="Hard stops" className="border-b border-rose-200 bg-rose-50/70 dark:border-rose-900/60 dark:bg-rose-950/20">
          <h3 className="flex items-center gap-1.5 px-4 pt-3 text-xs font-semibold text-rose-700 dark:text-rose-300">
            <OctagonX className="h-3.5 w-3.5" aria-hidden /> Hard stops — fix these first
          </h3>
          <NoteGroups groups={stops} taskId={taskId} onTab={onTab} />
        </section>
      ) : null}
      {r.warnings.length ? (
        <section aria-label="Warnings" className="border-app border-b">
          <div className="flex items-center justify-between gap-3 px-4 pt-3">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300">
              <TriangleAlert className="h-3.5 w-3.5" aria-hidden /> Warnings
            </h3>
            {r.warnings.length > FIRST_WARNINGS ? (
              <button type="button" onClick={() => setAll((a) => !a)} className="text-xs font-medium hover:underline">
                {all ? 'Show less' : `Show all ${r.warnings.length}`}
              </button>
            ) : null}
          </div>
          <NoteGroups groups={warnings} taskId={taskId} onTab={onTab} limit={all ? Infinity : FIRST_WARNINGS} />
        </section>
      ) : null}
      <div className="space-y-4 p-4">
        {checks.length ? (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4" aria-label="Checks">
            {checks.map((c) => (
              <Check key={c.label} {...c} />
            ))}
          </div>
        ) : null}
        {shown.length ? (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Overlap with other articles</h3>
            {shown.map((m) => (
              <DuplicateMatchCard key={m.id} m={m} />
            ))}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
