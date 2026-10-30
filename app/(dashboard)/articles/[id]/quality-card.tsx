'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { Card, Chip, KeyValue, cx, formatDateTime, type ChipTone } from '@/components/ui';
import { DuplicateMatchCard, type DuplicateMatchView } from '@/components/duplicate-match';
import type { QualitySections } from '@/lib/quality/report';

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

function FindingList({ items, tone, taskId }: { items: Finding[]; tone: 'danger' | 'warning'; taskId: string }) {
  return (
    <ul className="space-y-1.5 text-sm">
      {items.map((f, i) => (
        <li key={i} className="flex gap-2">
          <span className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', tone === 'danger' ? 'bg-rose-500' : 'bg-amber-500')} aria-hidden />
          <span>
            {f.message}{' '}
            {f.source === 'DUPLICATES' ? (
              <Link className="text-xs link" href="/duplicates">
                Duplicate Review
              </Link>
            ) : (
              <Link className="text-xs link" href={`/articles/${taskId}?tab=stages`}>
                {f.source}
              </Link>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The latest ArticleQualityReport: what stopped or flagged the article, and the evidence per area. */
export function QualityCard({ taskId }: { taskId: string }) {
  const [data, setData] = useState<{ report: Report | null; duplicates: DuplicateMatchView[] } | null>(null);
  useEffect(() => {
    void api<{ report: Report | null; duplicates: DuplicateMatchView[] }>(`/api/tasks/${taskId}/quality`).then(setData).catch(() => setData({ report: null, duplicates: [] }));
  }, [taskId]);
  if (!data) return <Card title="Quality report"><p className="text-muted text-sm">Loading…</p></Card>;
  const r = data.report;
  if (!r) return <Card title="Quality report"><p className="text-muted text-sm">Not evaluated yet — the quality gate runs after the SEO check.</p></Card>;
  const s = r.sections;
  const shown = data.duplicates.filter((d) => d.severity !== 'LOW');
  return (
    <Card
      title="Quality report"
      description={`${r.stage === 'VERIFIED_COMPLETE' ? 'Final check after the WordPress draft' : 'Quality gate'} · ${formatDateTime(r.createdAt)}`}
      actions={<Chip tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Chip>}
    >
      <div className="space-y-4">
        {r.hardStops.length ? (
          <div>
            <h3 className="mb-1 text-sm font-semibold">Hard stops</h3>
            <FindingList items={r.hardStops} tone="danger" taskId={taskId} />
          </div>
        ) : null}
        {r.warnings.length ? (
          <div>
            <h3 className="mb-1 text-sm font-semibold">Warnings</h3>
            <FindingList items={r.warnings} tone="warning" taskId={taskId} />
          </div>
        ) : null}
        {!r.hardStops.length && !r.warnings.length ? <p className="text-sm">All checks passed.</p> : null}
        <KeyValue
          items={[
            ...(s.seo ? [{ label: 'SEO readiness', value: `${s.seo.score}/100 (review below ${s.seo.threshold})${s.seo.failed.length ? ` · not met: ${s.seo.failed.slice(0, 4).join('; ')}` : ''}` }] : []),
            ...(s.structure ? [{ label: 'Structure', value: `${s.structure.words} words · ${s.structure.faqCount}/${s.structure.expectedFaqCount} FAQs${s.structure.quickBioRows !== null ? ` · Quick Bio ${s.structure.quickBioRows} rows${s.structure.quickBioColumnsOk === false ? ' (malformed)' : ''}` : ''}${s.structure.emptyHeadings ? ` · ${s.structure.emptyHeadings} empty heading(s)` : ''}${s.structure.duplicateSentences ? ` · ${s.structure.duplicateSentences} repeated sentence(s)` : ''}` }] : []),
            ...(s.evidence ? [{ label: 'Research evidence', value: `${s.evidence.sources} source URL(s) · ${s.evidence.uncertain} uncertainty note(s)` }] : []),
            ...(s.duplicates ? [{ label: 'Duplicates', value: s.duplicates.highest ? `${s.duplicates.highest.toLowerCase()} overlap with another article${s.duplicates.overridden ? ` — kept by you (“${s.duplicates.overrideReason}”)` : ''} · ${s.duplicates.compared} compared` : `no overlap in ${s.duplicates.compared} saved article(s)` }] : []),
            ...(s.links ? [{ label: 'Links', value: `${s.links.external} external · internal link line ${s.links.internalLinkLine ? 'present' : 'missing'}` }] : []),
            ...(s.images ? [{ label: 'Images', value: `${s.images.count} (${s.images.withAlt} with alt text)${s.images.required ? ' · required for this site' : ''}` }] : []),
            ...(s.rankMath ? [{ label: 'Rank Math (read from the editor)', value: s.rankMath.active === false ? 'not active on this site' : `${s.rankMath.score !== null ? `score ${s.rankMath.score}` : 'no score shown'}${s.rankMath.scoreVia ? ` via ${s.rankMath.scoreVia}` : ''} · fields ${s.rankMath.fieldsVerified ? 'verified' : 'not verified'}` }] : []),
            ...(s.wordpress ? [{ label: 'WordPress', value: s.wordpress.verified ? `draft #${s.wordpress.postId} verified (${s.wordpress.status})` : 'no verified draft' }] : []),
          ]}
        />
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
