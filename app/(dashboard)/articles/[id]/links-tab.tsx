'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ExternalLink, TextCursorInput, Unlink, Wand2 } from 'lucide-react';
import { api } from '@/lib/client/api';
import type { SerializedTaskDetail } from '@/lib/tasks/detail';
import { Button, ConfirmDialog, useToast } from '@/components/client';
import { Alert, Card, Chip, EmptyState, KeyValue, plural } from '@/components/ui';
import { Field, Input } from '@/components/form';

interface ExternalData {
  candidates: number;
  accepted: { phrase: string; url: string; finalUrl?: string; kind?: string; reason: string }[];
  rejected: { phrase: string; url: string; kind?: string; reason: string }[];
  warnings: string[];
  notes?: string[];
}

interface InternalData {
  line: string | null;
  url: string | null;
  title: string | null;
  reason: string | null;
  related?: { line: string; url: string; title: string; reason: string; anchor: string | null; placement: 'word' | 'line' } | null;
  contextual: { anchor: string; url: string; title: string }[];
  candidates: { title: string; url: string; score: number; related: boolean; reasons: string[] }[];
  index: { via: string; active: number; refreshed: boolean } | null;
  removedByOwner?: boolean;
  relatedRemovedByOwner?: boolean;
  switches?: { previous: boolean; related: boolean };
  warnings: string[];
  notes?: string[];
}

type Slot = 'line' | 'related';
interface PendingLink {
  slot: Slot;
  mode: 'auto' | 'none' | 'url';
  url?: string;
  title?: string;
  /** The related link only: the word or words to put it on. */
  anchor?: string;
  /** Opened with “Choose the word” (same post, another word). */
  chooseWord?: boolean;
}

function stageData<T>(task: SerializedTaskDetail, key: string): { status: string | null; data: T | null; message: string | null } {
  const s = task.stages.find((x) => x.key === key);
  return { status: s?.status ?? null, data: s?.outputJson ? (JSON.parse(s.outputJson) as T) : null, message: s?.message ?? null };
}

const short = (url: string) => url.replace(/^https?:\/\//, '').slice(0, 70);
const KIND_LABEL: Record<string, string> = { official: 'official site', 'edu-gov': 'gov / edu', reference: 'reference', imdb: 'IMDb', wikipedia: 'Wikipedia', news: 'news' };
/** “www.cbsnews.com/news/…” as the site in bold and the page in grey, on one line. */
function UrlLine({ url }: { url: string }) {
  let host = url;
  let rest = '';
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, '');
    rest = `${u.pathname}${u.search}`.replace(/^\/$/, '');
  } catch {
    /* shown as it is */
  }
  return (
    <a className="group flex min-w-0 items-center gap-1 text-xs" href={url} target="_blank" rel="noreferrer" title={url}>
      <span className="shrink-0 font-medium group-hover:underline">{host}</span>
      <span className="text-muted truncate">{rest}</span>
      <ExternalLink className="text-muted h-3 w-3 shrink-0" aria-hidden />
    </a>
  );
}

interface Suggestion {
  id: string;
  url: string;
  title: string;
  kind: string;
  anchor: string | null;
  score: number;
  status: string;
  note: string | null;
}
const SUGGESTION_STATUS: Record<string, { label: string; tone: 'success' | 'info' | 'warning' | 'neutral' | 'danger' }> = {
  SELECTED: { label: 'placed', tone: 'success' },
  PROPOSED: { label: 'not used', tone: 'info' },
  NO_ANCHOR: { label: 'no natural anchor', tone: 'neutral' },
  UNREACHABLE: { label: 'unreachable', tone: 'danger' },
};

/** Related posts considered for the related link (and the word links of earlier versions), and what happened to each. */
function SuggestionList({ taskId, refresh }: { taskId: string; refresh: string }) {
  const [rows, setRows] = useState<Suggestion[] | null>(null);
  useEffect(() => {
    void api<{ suggestions: Suggestion[] }>(`/api/tasks/${taskId}/link-suggestions`).then((r) => setRows(r.suggestions.filter((s) => s.kind === 'RELATED' || s.kind === 'CONTEXTUAL'))).catch(() => setRows([]));
  }, [taskId, refresh]);
  // The placed one is shown above; the list is for the others (not used, unreachable) and earlier word links.
  if (!rows?.some((r) => r.status !== 'SELECTED' || r.kind === 'CONTEXTUAL')) return null;
  return (
    <>
      <h4 className="mt-4 mb-2 text-sm font-semibold">Related posts considered</h4>
      <ul className="space-y-1.5 text-sm">
        {rows.map((r) => (
          <li key={r.id}>
            <Chip tone={SUGGESTION_STATUS[r.status]?.tone ?? 'neutral'}>{SUGGESTION_STATUS[r.status]?.label ?? r.status.toLowerCase()}</Chip>{' '}
            {r.anchor ? <span>“{r.anchor}” → </span> : null}
            <a className="link" href={r.url} target="_blank" rel="noreferrer">
              {r.title}
            </a>
            {r.note ? <span className="text-muted text-xs"> · {r.note}</span> : null}
          </li>
        ))}
      </ul>
    </>
  );
}

function dialogTitle(p: PendingLink): string {
  const middle = p.slot === 'related';
  if (p.mode === 'none') return middle ? 'Remove the related link?' : 'Remove the line at the end?';
  if (p.mode === 'auto') return middle ? 'Choose the related link automatically?' : 'Choose the line at the end automatically?';
  if (p.chooseWord) return `On which word should “${p.title}” be linked?`;
  return middle ? `Link “${p.title}” in the middle?` : `Link “${p.title}” at the end?`;
}

/** One of the two internal links (the end line, the related link) with what it links, why, and its buttons. */
function LinkSlot({
  heading,
  off,
  removed,
  link,
  reason,
  editable,
  onAuto,
  onRemove,
  onWord,
  emptyNote,
}: {
  heading: string;
  off: boolean;
  removed: boolean;
  link: { url: string; title: string; where: ReactNode } | null;
  /** Shown when there is no link and it is not off or removed. */
  emptyNote?: string;
  reason: string | null;
  editable: boolean;
  onAuto: () => void;
  onRemove: () => void;
  onWord?: () => void;
}) {
  return (
    <section className="border-app rounded-lg border px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{heading}</h4>
        {off ? <Chip>off</Chip> : removed ? <Chip tone="warning">removed by you</Chip> : link ? <Chip tone="success">linked</Chip> : <Chip>none</Chip>}
      </div>
      {link ? (
        <div className="mt-1.5 text-sm">
          <a className="link font-medium" href={link.url} target="_blank" rel="noreferrer">
            {link.title}
          </a>
          <span className="text-muted"> · </span>
          {link.where}
        </div>
      ) : (
        <p className="text-muted mt-1.5 text-sm">{off ? 'Turned off in Settings → SEO or on the website’s page.' : removed ? 'You removed this link; “Automatic” brings it back.' : emptyNote ?? 'No post of this website fits yet (see the notes above).'}</p>
      )}
      {link && reason ? <p className="text-muted mt-0.5 text-xs">Why: {reason}</p> : null}
      {editable && !off ? (
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button size="sm" onClick={onAuto} title="Let the app choose again">
            <Wand2 className="h-3.5 w-3.5" /> Automatic
          </Button>
          {onWord ? (
            <Button size="sm" onClick={onWord} title="Choose the word the link goes on">
              <TextCursorInput className="h-3.5 w-3.5" /> Choose the word
            </Button>
          ) : null}
          {link ? (
            <Button size="sm" variant="ghost" onClick={onRemove}>
              <Unlink className="h-3.5 w-3.5" /> Remove
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function LinksTab({ task, onChanged }: { task: SerializedTaskDetail; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const ext = stageData<ExternalData>(task, 'EXTERNAL_LINKS');
  const int = stageData<InternalData>(task, 'INTERNAL_LINKS');
  const [pending, setPending] = useState<PendingLink | null>(null);
  const [busy, setBusy] = useState(false);

  async function apply() {
    if (!pending) return;
    setBusy(true);
    try {
      const { chooseWord, ...choice } = pending;
      void chooseWord;
      await api(`/api/tasks/${task.id}/internal-link`, { body: { ...choice, anchor: choice.anchor?.trim() || undefined } });
      toast('success', 'Internal link updated — the article is re-assembled and the same WordPress draft is updated.');
      await onChanged();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Card title="External links" description="Suggested by ChatGPT, then verified here: reachable, same site after redirects, about the linked phrase, no social media, shops, shorteners or net-worth aggregators. Wikipedia ≤ half.">
        {!ext.data ? (
          <EmptyState title={ext.status === 'SKIPPED' ? 'External links are off for this article' : 'Not checked yet'} description={ext.message ?? undefined} />
        ) : (
          <>
            {ext.data.warnings.map((w, i) => (
              <Alert key={i} tone="warning">
                {w}
              </Alert>
            ))}
            {(ext.data.notes ?? []).map((w, i) => (
              <Alert key={`n${i}`} tone="info">
                {w}
              </Alert>
            ))}
            <h4 className="mt-2 mb-1 text-sm font-semibold">Added ({ext.data.accepted.length})</h4>
            <ul className="divide-y divide-[var(--border)] text-sm">
              {ext.data.accepted.map((a, i) => (
                <li key={i} className="py-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">“{a.phrase}”</span>
                    {a.kind && KIND_LABEL[a.kind] ? <Chip>{KIND_LABEL[a.kind]}</Chip> : null}
                  </div>
                  <UrlLine url={a.finalUrl ?? a.url} />
                  <div className="text-muted text-xs">{a.reason}</div>
                </li>
              ))}
            </ul>
            {ext.data.rejected.length ? (
              <details className="mt-4">
                <summary className="cursor-pointer text-sm font-semibold">Rejected ({ext.data.rejected.length}) — with the actual reason</summary>
                <ul className="mt-2 space-y-2 text-sm">
                  {ext.data.rejected.map((r, i) => (
                    <li key={i}>
                      <span className="font-medium">“{r.phrase}”</span> <span className="text-muted break-all">{short(r.url)}</span>
                      <div className="text-xs text-amber-700 dark:text-amber-300">{r.reason}</div>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        )}
      </Card>

      <Card
        title="Internal links"
        description="Two links to posts of this website: the previous article at the end, and a related article in the middle, on a word the article already uses (otherwise as a line between two sections). Drafts and this article itself are never linked. Each link can be turned off in Settings → SEO or on the website's page."
      >
        {!int.data ? (
          <EmptyState title={int.status === 'SKIPPED' ? 'Internal links are off for this article' : 'Not chosen yet'} description={int.message ?? undefined} />
        ) : (
          <>
            {int.data.warnings.map((w, i) => (
              <Alert key={i} tone="warning">
                {w}
              </Alert>
            ))}
            {(int.data.notes ?? []).map((w, i) => (
              <Alert key={`n${i}`} tone="info">
                {w}
              </Alert>
            ))}
            <div className="mt-2 grid gap-3">
              <LinkSlot
                heading="Previous article · end of the article"
                off={int.data.switches?.previous === false}
                removed={Boolean(int.data.removedByOwner)}
                link={int.data.url ? { url: int.data.url, title: int.data.title ?? int.data.url, where: <span>on the “{int.data.line}” line at the end</span> } : null}
                reason={int.data.reason}
                editable={!task.legacy}
                onAuto={() => setPending({ slot: 'line', mode: 'auto' })}
                onRemove={() => setPending({ slot: 'line', mode: 'none' })}
              />
              <LinkSlot
                heading="Related article · middle of the article"
                off={int.data.switches?.related === false}
                emptyNote={int.data.related === undefined ? 'This article was linked before the related link existed. “Automatic” adds it.' : undefined}
                removed={Boolean(int.data.relatedRemovedByOwner)}
                link={
                  int.data.related
                    ? {
                        url: int.data.related.url,
                        title: int.data.related.title,
                        where: int.data.related.placement === 'word' ? <span>on the word “{int.data.related.anchor}”</span> : <span>as a line between two sections</span>,
                      }
                    : null
                }
                reason={int.data.related?.reason ?? null}
                editable={!task.legacy}
                onAuto={() => setPending({ slot: 'related', mode: 'auto' })}
                onRemove={() => setPending({ slot: 'related', mode: 'none' })}
                onWord={int.data.related ? () => setPending({ slot: 'related', mode: 'url', url: int.data!.related!.url, title: int.data!.related!.title, anchor: int.data!.related!.anchor ?? '', chooseWord: true }) : undefined}
              />
            </div>
            <div className="mt-3" />
            <KeyValue
              items={[
                ...(int.data.contextual.length ? [{ label: 'Word links (earlier version)', value: int.data.contextual.map((c) => `“${c.anchor}” → ${c.title}`).join(' · ') }] : []),
                { label: 'Link index', value: int.data.index ? `${plural(int.data.index.active, 'published post')} · ${int.data.index.refreshed ? `refreshed via ${int.data.index.via}` : 'cached'}` : '—' },
              ]}
            />
            {int.data.candidates.length ? (
              <>
                <h4 className="mt-4 mb-2 text-sm font-semibold">Posts of this website (best match first)</h4>
                <ul className="divide-y divide-[var(--border)] text-sm">
                  {int.data.candidates.map((c) => {
                    const atEnd = c.url === int.data!.url;
                    const inMiddle = c.url === int.data!.related?.url;
                    return (
                      <li key={c.url} className="flex items-start gap-3 py-2.5">
                        <div className="min-w-0 flex-1">
                          <a className="link" href={c.url} target="_blank" rel="noreferrer">
                            {c.title}
                          </a>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            <Chip tone={c.related ? 'success' : 'neutral'}>{c.related ? 'related' : 'fallback'}</Chip>
                            <span className="text-muted text-xs">score {c.score}</span>
                            {atEnd ? <Chip tone="brand">at the end</Chip> : null}
                            {inMiddle ? <Chip tone="brand">in the middle</Chip> : null}
                          </div>
                          {c.reasons.length ? <div className="text-muted mt-0.5 text-xs">{c.reasons.join(' · ')}</div> : null}
                        </div>
                        {!task.legacy && !atEnd && !inMiddle ? (
                          <div className="flex shrink-0 flex-col gap-1.5 sm:flex-row">
                            <Button size="sm" onClick={() => setPending({ slot: 'line', mode: 'url', url: c.url, title: c.title })} title="Use this post for the line at the end">
                              At the end
                            </Button>
                            <Button size="sm" onClick={() => setPending({ slot: 'related', mode: 'url', url: c.url, title: c.title, anchor: '' })} title="Use this post for the related link in the middle">
                              In the middle
                            </Button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}
            <SuggestionList taskId={task.id} refresh={`${int.data.related?.url ?? ''}|${int.data.url ?? ''}`} />
          </>
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(pending)}
        title={pending ? dialogTitle(pending) : ''}
        confirmLabel="Apply"
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => void apply()}
      >
        {pending?.slot === 'related' && pending.mode === 'url' ? (
          <Field
            label="On which word?"
            htmlFor="related-anchor"
            help="Optional. Words the article already uses, e.g. a person's name. Empty: the app chooses the word, or adds the link as a line in the middle when no word fits. The article text is not changed."
            className="mb-3"
          >
            <Input id="related-anchor" value={pending.anchor ?? ''} maxLength={120} placeholder="e.g. Heidi Klum" onChange={(e) => setPending({ ...pending, anchor: e.target.value })} />
          </Field>
        ) : null}
        The article is re-assembled with this choice (your choice is kept on later runs). If a WordPress draft exists, the same draft is updated.
      </ConfirmDialog>
    </div>
  );
}
