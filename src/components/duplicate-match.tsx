'use client';

import Link from 'next/link';
import { Chip, type ChipTone } from '@/components/ui';

export interface DuplicateExcerptView {
  kind: 'wording' | 'fact' | 'near' | 'paragraph';
  words: number;
  article: { before: string; match: string; after: string };
  other: { before: string; match: string; after: string };
}
export interface DuplicateMatchView {
  id: string;
  otherTaskId: string;
  otherTitle: string;
  otherWebsite: string;
  sameWebsite: boolean;
  severity: string;
  wordingWords: number;
  factWords: number;
  longestRun: number;
  nearSentences: number;
  exactParagraphs: number;
  wordingShare: number;
  status: string;
  excerpts: DuplicateExcerptView[];
}

export const SEVERITY_TONE: Record<string, ChipTone> = { HIGH: 'danger', MEDIUM: 'warning', LOW: 'neutral' };
const SEVERITY_LABEL: Record<string, string> = { HIGH: 'heavy overlap', MEDIUM: 'some overlap', LOW: 'minor overlap' };
const KIND_LABEL: Record<DuplicateExcerptView['kind'], string> = { wording: 'identical wording', fact: 'shared facts (names, dates, numbers)', near: 'similar sentence', paragraph: 'identical paragraph' };

function Marked({ h }: { h: { before: string; match: string; after: string } }) {
  return (
    <p className="text-sm leading-relaxed">
      <span className="text-muted">{h.before}</span>
      <mark className="rounded bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-700/50">{h.match}</mark>
      <span className="text-muted">{h.after}</span>
    </p>
  );
}

/** One overlap between an article and another saved article: counts, kind of overlap and the passages side by side. */
export function DuplicateMatchCard({ m }: { m: DuplicateMatchView }) {
  return (
    <div className="border-app rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Chip tone={SEVERITY_TONE[m.severity] ?? 'neutral'}>{SEVERITY_LABEL[m.severity] ?? m.severity.toLowerCase()}</Chip>
        {m.status === 'OVERRIDDEN' ? <Chip>kept by you</Chip> : null}
        <span>
          vs{' '}
          <Link className="text-indigo-600 underline" href={`/articles/${m.otherTaskId}`}>
            {m.otherTitle}
          </Link>{' '}
          <span className="text-muted">· {m.sameWebsite ? 'same website' : m.otherWebsite}</span>
        </span>
      </div>
      <p className="text-muted mt-1 text-xs">
        {Math.round(m.wordingShare * 100)} % of the words in identical runs of 8+ words · longest run {m.longestRun} words · {m.exactParagraphs} identical paragraph(s) · {m.nearSentences} similar sentence(s) · {m.factWords} words of shared facts (not counted as duplication)
      </p>
      {m.excerpts.length ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-indigo-600">Show the passages ({m.excerpts.length})</summary>
          <ul className="mt-2 space-y-3">
            {m.excerpts.map((e, i) => (
              <li key={i}>
                <div className="text-muted mb-1 text-xs font-medium">
                  {KIND_LABEL[e.kind]} · {e.words} words
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <div className="text-muted mb-0.5 text-xs uppercase">This article</div>
                    <Marked h={e.article} />
                  </div>
                  <div>
                    <div className="text-muted mb-0.5 text-xs uppercase">Other article</div>
                    <Marked h={e.other} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
