'use client';

import type { SerializedTaskDetail } from '@/lib/tasks/detail';
import { Card, EmptyState, KeyValue, formatDateTime } from '@/components/ui';

export const EXTRA_TABS = ['titles', 'research', 'editor', 'seo', 'images'] as const;
export type ExtraTab = (typeof EXTRA_TABS)[number];

/**
 * Content tabs. Read-only views of persisted outputs; approval/editing actions
 * are added with the content pipeline (M5).
 */
export function ArticleExtraTabs({ tab, task }: { tab: ExtraTab; task: SerializedTaskDetail; onChanged: () => Promise<void> }) {
  if (tab === 'titles') {
    if (task.titleOptionList.length === 0 && !task.selectedTitle) return <Card><EmptyState title="No titles yet" description="Titles appear after the TITLES stage." /></Card>;
    return (
      <Card title="Title options">
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {task.titleOptionList.map((t, i) => (
            <li key={i} className={t === task.selectedTitle ? 'font-semibold' : ''}>
              {t}
            </li>
          ))}
        </ol>
        <div className="mt-4">
          <KeyValue
            items={[
              { label: 'Recommended', value: task.recommendedTitle ?? '—' },
              { label: 'Selected', value: task.selectedTitle ?? '—' },
              { label: 'Approved', value: formatDateTime(task.titleApprovedAt) },
            ]}
          />
        </div>
      </Card>
    );
  }
  if (tab === 'research') {
    return task.researchNotes ? (
      <Card title="Research notes" description="Stored separately from the published prose; never inserted into the article body.">
        <pre className="surface-2 max-h-[70vh] overflow-auto rounded-lg p-3 text-xs whitespace-pre-wrap">{task.researchNotes}</pre>
      </Card>
    ) : (
      <Card><EmptyState title="No research yet" /></Card>
    );
  }
  if (tab === 'seo') {
    return task.seoReports.length === 0 ? (
      <Card><EmptyState title="No SEO report yet" /></Card>
    ) : (
      <div className="space-y-4">
        {task.seoReports.map((r) => (
          <Card key={r.id} title={`${r.source === 'RANKMATH' ? 'Rank Math (live)' : 'Internal checks'} · ${r.score ?? 'not verified'}`} description={formatDateTime(r.createdAt)}>
            <pre className="surface-2 max-h-80 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">{r.checks}</pre>
          </Card>
        ))}
      </div>
    );
  }
  if (tab === 'images') {
    return task.mediaAssets.length === 0 ? (
      <Card><EmptyState title="No images" description="Images are optional; missing images are reported as review reasons, never faked." /></Card>
    ) : (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {task.mediaAssets.map((m) => (
          <Card key={m.id} title={m.role} description={`${m.width ?? '?'}×${m.height ?? '?'} · ${m.status}`}>
            <p className="text-sm">{m.altText ?? 'No alt text'}</p>
          </Card>
        ))}
      </div>
    );
  }
  // editor
  return task.assembledHtml || task.bodyHtml ? (
    <Card title="Article (read-only preview)">
      <div className="article-preview" dangerouslySetInnerHTML={{ __html: task.editedHtml ?? task.assembledHtml ?? task.bodyHtml ?? '' }} />
    </Card>
  ) : (
    <Card><EmptyState title="No article body yet" /></Card>
  );
}
