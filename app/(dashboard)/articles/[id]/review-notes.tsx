'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { ChevronDown, Info, TriangleAlert } from 'lucide-react';
import { NOTE_SOURCES, groupReviewNotes, type ReviewNote } from '@/lib/review-notes';
import { Chip, cx } from '@/components/ui';

/** Notes shown before “Show all” when the article is not held for review. */
const FIRST = 4;

/**
 * The article's notes or review reasons (owner report: “Notes (10)” was a wall of long sentences with “[SOURCE]”
 * tags). Grouped by where they came from, one short line each with the quoted text under it; a click shows the
 * research notes and what to do, and each group links to the page that shows it in full.
 */
export function ReviewNotes({ reasons, taskId, held, onTab, actions }: { reasons: string[]; taskId: string; held: boolean; onTab: (tab: string) => void; actions?: ReactNode }) {
  const groups = groupReviewNotes(reasons);
  // Reasons that hold the article are all shown; plain notes start with the first few.
  const [all, setAll] = useState(held);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const Icon = held ? TriangleAlert : Info;
  let left = all ? Infinity : FIRST;
  return (
    <section className={cx('surface rounded-xl border', held && 'border-amber-500/40')} aria-label={held ? 'Review reasons' : 'Notes'}>
      <header className="border-app flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3">
        <Icon className={cx('h-4 w-4 shrink-0', held ? 'text-amber-500' : 'text-sky-500')} aria-hidden />
        <h2 className="text-sm font-semibold">{held ? 'Review reasons' : 'Notes'}</h2>
        <Chip tone={held ? 'warning' : 'neutral'}>{reasons.length}</Chip>
        <span className="text-muted text-xs">{groups.map((g) => `${g.label} ${g.notes.length}`).join(' · ')}</span>
        {reasons.length > FIRST && !held ? (
          <button type="button" onClick={() => setAll((a) => !a)} className="ml-auto text-xs font-medium hover:underline">
            {all ? 'Show less' : `Show all ${reasons.length}`}
          </button>
        ) : null}
      </header>
      <div className="divide-y divide-[var(--border)]">
        {groups.map((g) => {
          const shown = g.notes.slice(0, Math.max(0, left));
          left -= shown.length;
          if (!shown.length) return null;
          const where = g.source ? NOTE_SOURCES[g.source] : undefined;
          return (
            <div key={g.label} className="px-4 py-3">
              <div className="mb-1 flex items-center justify-between gap-3">
                <h3 className="text-muted text-[11px] font-semibold uppercase tracking-wider">
                  {g.label} · {g.notes.length}
                </h3>
                {where?.page ? (
                  <Link href={where.page(taskId)} className="text-xs font-medium hover:underline">
                    {where.pageLabel} →
                  </Link>
                ) : where?.tab ? (
                  <button type="button" onClick={() => onTab(where.tab!)} className="text-xs font-medium hover:underline">
                    Open the {where.tab === 'editor' ? 'Editor' : where.tab === 'seo' ? 'SEO' : where.tab === 'images' ? 'Images' : 'Stages'} tab →
                  </button>
                ) : null}
              </div>
              <ul className="space-y-0.5">
                {shown.map((n, i) => {
                  const key = `${g.label}:${i}`;
                  return (
                    <NoteRow
                      key={key}
                      note={n}
                      open={open.has(key)}
                      onToggle={() =>
                        setOpen((s) => {
                          const next = new Set(s);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                    />
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      {actions ? <div className="border-app flex flex-wrap gap-2 border-t px-4 py-3">{actions}</div> : null}
    </section>
  );
}

function NoteRow({ note, open, onToggle }: { note: ReviewNote; open: boolean; onToggle: () => void }) {
  const details = note.notes.length > 0 || Boolean(note.more) || Boolean(note.advice) || Boolean(note.quote && note.quote.length > 90);
  return (
    <li>
      <button
        type="button"
        aria-expanded={details ? open : undefined}
        onClick={details ? onToggle : undefined}
        className={cx('-mx-2 flex w-[calc(100%+1rem)] items-start gap-2 rounded-md px-2 py-1.5 text-left', details && 'hover:bg-[var(--surface-2)]')}
      >
        <ChevronDown className={cx('text-muted mt-0.5 h-3.5 w-3.5 shrink-0 transition', !open && '-rotate-90', !details && 'invisible')} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{note.title}</span>
          {note.quote ? <span className={cx('text-muted block text-xs', !open && 'line-clamp-1')}>“{note.quote}”</span> : null}
        </span>
      </button>
      {open ? (
        <div className="mb-1.5 ml-[22px] space-y-1.5 text-xs">
          {note.notes.length ? (
            <div>
              <div className="text-muted font-medium">{note.source === 'RESEARCH_EVIDENCE' ? `Research note${note.notes.length > 1 ? 's' : ''}` : 'Details'}</div>
              <ul className="list-disc space-y-0.5 pl-4">
                {note.notes.map((t, i) => (
                  <li key={i}>{note.source === 'RESEARCH_EVIDENCE' ? `“${t}”` : t}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {note.more ? <p className="text-muted">And {note.more}.</p> : null}
          {note.advice ? <p className="font-medium">{note.advice}</p> : null}
        </div>
      ) : null}
    </li>
  );
}
