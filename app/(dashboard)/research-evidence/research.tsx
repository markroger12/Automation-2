'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, RelativeTime, useToast } from '@/components/client';
import { Field, Input, Select, Textarea } from '@/components/form';
import { Alert, Card, Chip, EmptyState, StatusChip, cx, formatDateTime, type ChipTone } from '@/components/ui';

interface LedgerRow {
  task: { id: string; title: string; keyword: string; status: string; website: string };
  researchedAt: string | null;
  byStatus: Record<string, number>;
  openHighImpact: number;
}
interface Evidence {
  url: string;
  host: string;
  verdict: 'SUPPORTS' | 'CONTRADICTS' | 'NO_MENTION';
  excerpt: string | null;
  detail: string | null;
}
interface Claim {
  id: string;
  claimType: string;
  claimText: string;
  values: { dates: string[]; amounts: number[]; names: string[] };
  nature: string;
  highImpact: boolean;
  status: string;
  citations: string[];
  evidence: Evidence[];
  articleParagraph: number | null;
  ownerDecision: string | null;
  ownerValue: string | null;
  ownerNote: string | null;
  decidedAt: string | null;
}
interface Detail {
  task: { id: string; title: string; status: string; website: { name: string } };
  claims: Claim[];
  sources: { id: string; url: string; host: string; title: string; status: string; httpStatus: number | null; detail: string | null; fetchedAt: string }[];
  notes: string[];
  changes: null | { previousTaskId: string; previousResearchedAt: string; changes: { type: string; kind: 'NEW' | 'CHANGED' | 'GONE'; before: string[]; now: string[] }[] };
  researchedAt: string | null;
}

const STATUS: Record<string, { tone: ChipTone; label: string }> = {
  VERIFIED: { tone: 'success', label: 'verified (2+ sources)' },
  SINGLE_SOURCE: { tone: 'info', label: 'one source' },
  ESTIMATE: { tone: 'neutral', label: 'estimate' },
  DISPUTED: { tone: 'warning', label: 'disputed / rumour' },
  CONTRADICTED: { tone: 'danger', label: 'sources disagree' },
  UNVERIFIED: { tone: 'warning', label: 'no source found' },
};
const TYPE: Record<string, string> = { BIRTH: 'Birth', DEATH: 'Death', FAMILY: 'Family / relationship', EDUCATION: 'Education', AWARD: 'Award', NET_WORTH: 'Net worth', CAREER: 'Career' };
const NATURE: Record<string, string> = { REPORTED_FACT: 'reported fact', ESTIMATE: 'estimate', UNVERIFIED_CLAIM: 'unverified claim' };
const DECISION: Record<string, string> = { ACCEPTED: 'accepted by you', OMIT: 'leave out', CORRECTED: 'corrected by you' };
const SOURCE_TONE: Record<string, ChipTone> = { OK: 'success', DEAD: 'danger', BLOCKED: 'danger', NOT_HTML: 'warning', FAILED: 'warning' };

function ClaimCard({ c, onChanged }: { c: Claim; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [decision, setDecision] = useState('ACCEPTED');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const values = [...c.values.dates, ...c.values.amounts.map((a) => a.toLocaleString('en-US')), ...c.values.names];
  const needsAttention = c.highImpact && ['CONTRADICTED', 'UNVERIFIED', 'DISPUTED'].includes(c.status) && !c.ownerDecision;
  async function run(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      toast('success', done);
      await onChanged();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className={cx('border-app rounded-lg border p-3', needsAttention && 'border-amber-400')}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold">{TYPE[c.claimType] ?? c.claimType}</span>
        <Chip tone={STATUS[c.status]?.tone ?? 'neutral'}>{STATUS[c.status]?.label ?? c.status}</Chip>
        <Chip>{NATURE[c.nature] ?? c.nature}</Chip>
        {c.highImpact ? <Chip tone="brand">high impact</Chip> : null}
        {c.articleParagraph !== null ? <span className="text-muted text-xs">in the article, paragraph {c.articleParagraph + 1}</span> : <span className="text-muted text-xs">not stated in the article</span>}
      </div>
      <p className="mt-1 text-sm">{c.claimText}</p>
      {values.length ? <p className="text-muted mt-0.5 text-xs">Checked values: {values.join(' · ')}</p> : null}
      {c.evidence.length ? (
        <ul className="mt-2 space-y-1.5">
          {c.evidence.map((e, i) => (
            <li key={i} className="text-xs">
              <Chip tone={e.verdict === 'SUPPORTS' ? 'success' : 'danger'}>{e.verdict === 'SUPPORTS' ? 'supports' : 'contradicts'}</Chip>{' '}
              <a className="inline-flex items-center gap-1 link" href={e.url} target="_blank" rel="noreferrer noopener">
                {e.host} <ExternalLink className="h-3 w-3" />
              </a>
              {e.detail ? <span className="ml-1 font-medium">{e.detail}</span> : null}
              {e.excerpt ? <span className="text-muted block pl-1">“{e.excerpt}”</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted mt-2 text-xs">No usable source mentions it{c.citations.length ? ` (cited: ${c.citations.length})` : ''}.</p>
      )}
      {c.ownerDecision ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <Chip tone="brand">{DECISION[c.ownerDecision]}</Chip>
          {c.ownerValue ? <span>Value: {c.ownerValue}</span> : null}
          <span className="text-muted">“{c.ownerNote}” · {c.decidedAt ? formatDateTime(c.decidedAt) : ''}</span>
          <Button size="sm" variant="ghost" loading={busy} onClick={() => void run(() => api(`/api/research/claims/${c.id}/decision`, { method: 'DELETE' }), 'Decision cleared.')}>
            Clear
          </Button>
        </div>
      ) : (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs link-plain">Decide</summary>
          <div className="mt-2 grid gap-2 md:grid-cols-[180px_1fr]">
            <Field label="Decision" htmlFor={`d-${c.id}`}>
              <Select id={`d-${c.id}`} value={decision} onChange={(e) => setDecision(e.target.value)}>
                <option value="ACCEPTED">Accept as it is</option>
                <option value="OMIT">Leave it out of the article</option>
                <option value="CORRECTED">Correct the value</option>
              </Select>
            </Field>
            {decision === 'CORRECTED' ? (
              <Field label="Correct value" htmlFor={`v-${c.id}`}>
                <Input id={`v-${c.id}`} value={value} onChange={(e) => setValue(e.target.value)} />
              </Field>
            ) : (
              <div />
            )}
            <div className="md:col-span-2">
              <Field label="Why (kept with the sources)" htmlFor={`n-${c.id}`}>
                <Textarea id={`n-${c.id}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            </div>
          </div>
          <Button size="sm" variant="primary" className="mt-2" disabled={note.trim().length < 5 || (decision === 'CORRECTED' && !value.trim())} loading={busy} onClick={() => void run(() => api(`/api/research/claims/${c.id}/decision`, { body: { decision, value: value || undefined, note } }), 'Decision saved.')}>
            Save decision
          </Button>
          {decision !== 'ACCEPTED' ? <p className="text-muted mt-1 text-xs">The article itself is not changed: edit it in the Editor tab (or regenerate the stage), then retry.</p> : null}
        </details>
      )}
    </li>
  );
}

export function ResearchEvidence({ initialTaskId }: { initialTaskId?: string }) {
  const toast = useToast();
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(initialTaskId ?? null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadList = useCallback(async () => {
    try {
      const r = (await api<{ ledgers: LedgerRow[] }>('/api/research')).ledgers;
      setRows(r);
      setSelected((s) => s ?? r[0]?.task.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  const loadDetail = useCallback(async () => {
    if (!selected) return setDetail(null);
    try {
      setDetail(await api<Detail>(`/api/research/${selected}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selected]);
  useEffect(() => void loadList(), [loadList]);
  useEffect(() => void loadDetail(), [loadDetail]);

  if (error) return <Alert tone="danger" title="Could not load">{error}</Alert>;
  if (rows === null) return <div className="surface-2 h-40 animate-pulse rounded-xl" aria-busy="true" />;
  if (!rows.length)
    return (
      <Card>
        <EmptyState title="No evidence ledgers yet" description="Celebrity articles build one after their research step: the claims in the research notes, checked against the sources they cite." />
      </Card>
    );
  return (
    <div className="grid gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
      <Card title="Articles" padded={false}>
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {rows.map((r) => (
            <li key={r.task.id}>
              <button type="button" onClick={() => setSelected(r.task.id)} className={cx('w-full px-4 py-2.5 text-left text-sm', selected === r.task.id ? 'bg-indigo-50/60 dark:bg-indigo-950/40' : 'hover:bg-[var(--surface-2)]')}>
                <span className="block truncate font-medium">{r.task.title}</span>
                <span className="text-muted block text-xs">
                  {r.task.website} · {Object.entries(r.byStatus).map(([k, v]) => `${v} ${STATUS[k]?.label ?? k}`).join(', ')}
                </span>
                {r.openHighImpact ? <Chip tone="warning">{r.openHighImpact} to check</Chip> : null}
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <div className="min-w-0 space-y-6">
        {detail ? (
          <>
            <Card
              title={detail.task.title}
              description={detail.researchedAt ? `Researched ${formatDateTime(detail.researchedAt)} · ${detail.task.website.name}` : undefined}
              actions={
                <div className="flex flex-wrap gap-2">
                  <Link className="text-sm link" href={`/articles/${detail.task.id}`}>
                    Open article
                  </Link>
                  <Button
                    size="sm"
                    onClick={async () => {
                      try {
                        await api(`/api/research/${detail.task.id}/recheck`, { method: 'POST' });
                        toast('success', 'Re-check queued: the worker fetches the sources again.');
                      } catch (e) {
                        toast('error', (e as Error).message);
                      }
                    }}
                  >
                    <RefreshCw className="h-4 w-4" /> Re-check sources
                  </Button>
                </div>
              }
            >
              <div className="space-y-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip status={detail.task.status} />
                  <span className="text-muted">A claim counts as verified only when two different websites about this person contain its value. An answer from ChatGPT is never evidence by itself.</span>
                </div>
                {detail.changes ? (
                  <Alert tone="info" title={`Changes since the research of ${formatDateTime(detail.changes.previousResearchedAt)}`}>
                    {detail.changes.changes.length ? (
                      <ul className="list-disc pl-5">
                        {detail.changes.changes.map((ch, i) => (
                          <li key={i}>
                            {TYPE[ch.type] ?? ch.type}: {ch.kind === 'NEW' ? `new — ${ch.now.join(', ')}` : ch.kind === 'GONE' ? `no longer mentioned (was ${ch.before.join(', ')})` : `${ch.before.join(', ')} → ${ch.now.join(', ')}`}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      'No changes in the checked facts.'
                    )}{' '}
                    <Link className="underline" href={`/research-evidence?task=${detail.changes.previousTaskId}`}>
                      Earlier article
                    </Link>
                  </Alert>
                ) : null}
                {detail.notes.length ? (
                  <ul className="text-muted list-disc pl-5 text-xs">
                    {detail.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </Card>
            <Card title={`Claims (${detail.claims.length})`} description="High-impact facts (birth, death, family, money) first.">
              {detail.claims.length ? (
                <ul className="space-y-3">
                  {detail.claims.map((c) => (
                    <ClaimCard key={c.id} c={c} onChanged={loadDetail} />
                  ))}
                </ul>
              ) : (
                <p className="text-muted text-sm">No checkable claims (dates, amounts or names) in the research notes.</p>
              )}
            </Card>
            <Card title="Sources" padded={false}>
              <table className="table-app">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Status</th>
                    <th>Fetched</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.sources.map((s) => (
                    <tr key={s.id}>
                      <td className="max-w-md">
                        <a className="break-all link" href={s.url} target="_blank" rel="noreferrer noopener">
                          {s.title || s.url}
                        </a>
                        {s.detail ? <div className="text-muted text-xs">{s.detail}</div> : null}
                      </td>
                      <td>
                        <Chip tone={SOURCE_TONE[s.status] ?? 'neutral'}>{s.status.toLowerCase()}</Chip>
                      </td>
                      <td className="text-xs">
                        <RelativeTime value={s.fetchedAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </>
        ) : null}
      </div>
    </div>
  );
}
