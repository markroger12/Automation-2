'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Trash2, Upload } from 'lucide-react';
import { api, upload } from '@/lib/client/api';
import { Button, useToast } from '@/components/client';
import { Input, Select } from '@/components/form';
import { Alert, Card, Chip, EmptyState, formatDateTime } from '@/components/ui';

interface Stats {
  days: number;
  start: string;
  end: string;
  covered: number;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}
interface Trend {
  days: number;
  current: Stats;
  previous: Stats | null;
  clicksChangePct: number | null;
  impressionsChangePct: number | null;
}
interface PageRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  prevClicks: number | null;
  taskId?: string | null;
  title?: string | null;
}
interface Snapshot {
  id: string;
  fileName: string;
  startDate: string;
  endDate: string;
  compare: boolean;
  pageRows: number;
  queryRows: number;
  dateRows: number;
  importedAt: string;
  notes: string[];
}
interface Data {
  state: 'NOT_CONNECTED' | 'NO_DATA' | 'DATA';
  site: { id: string; name: string };
  property: string | null;
  snapshots: Snapshot[];
  timezoneNote?: string;
  trend?: { latest: string | null; trends: Trend[] };
  pagesReport?: { start: string; end: string; compare: boolean; capped: boolean } | null;
  queriesReport?: { start: string; end: string } | null;
  pages?: PageRow[];
  queries?: PageRow[];
  declining?: { url: string; clicks: number; prevClicks: number; changePct: number; basis: string; taskId: string | null; title: string | null }[];
  zero?: { taskId: string; title: string; url: string; detail: string }[];
  indexing?: { published: number; requested: number; confirmedByOwner: number; seenInSearch: number };
}

const n = (v: number | null | undefined, digits = 0) => (v == null ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: digits }));
const change = (v: number | null) => (v == null ? null : <span className={v < 0 ? 'text-rose-700 dark:text-rose-300' : 'text-emerald-700 dark:text-emerald-300'}>{`${v > 0 ? '+' : ''}${v} %`}</span>);
const shortUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '');

function TrendCard({ t }: { t: Trend }) {
  const complete = t.current.covered === t.days;
  return (
    <Card title={`Last ${t.days} days`} description={`${t.current.start} – ${t.current.end} · ${t.current.covered}/${t.days} days with data`}>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-muted text-xs">Clicks</dt>
          <dd className="text-lg font-semibold tabular-nums">{n(t.current.clicks)}</dd>
          <dd className="text-xs">{change(t.clicksChangePct) ?? <span className="text-muted">no complete earlier period</span>}</dd>
        </div>
        <div>
          <dt className="text-muted text-xs">Impressions</dt>
          <dd className="text-lg font-semibold tabular-nums">{n(t.current.impressions)}</dd>
          <dd className="text-xs">{change(t.impressionsChangePct) ?? <span className="text-muted">no complete earlier period</span>}</dd>
        </div>
        <div>
          <dt className="text-muted text-xs">CTR</dt>
          <dd className="tabular-nums">{t.current.ctr == null ? '—' : `${t.current.ctr} %`}</dd>
        </div>
        <div>
          <dt className="text-muted text-xs">Average position</dt>
          <dd className="tabular-nums">{n(t.current.position, 1)}</dd>
        </div>
      </dl>
      {!complete ? <p className="text-muted mt-2 text-xs">Only {t.current.covered} of {t.days} days are in the imported reports; totals cover those days.</p> : null}
    </Card>
  );
}

function ImportForm({ websiteId, onDone }: { websiteId: string; onDone: () => Promise<void> }) {
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send() {
    const files = ref.current?.files;
    if (!files?.length) {
      setError('Choose the export first.');
      return;
    }
    const form = new FormData();
    for (const f of Array.from(files)) form.append('files', f);
    if (start) form.append('start', start);
    if (end) form.append('end', end);
    setBusy(true);
    setError(null);
    try {
      const res = await upload<{ snapshot: { startDate: string; endDate: string; pageRows: number; queryRows: number; dateRows: number }; warnings: string[] }>(`/api/search-performance/${websiteId}/import`, form);
      toast('success', `Imported ${res.snapshot.startDate} – ${res.snapshot.endDate}: ${res.snapshot.pageRows} pages, ${res.snapshot.queryRows} queries, ${res.snapshot.dateRows} days.`);
      if (ref.current) ref.current.value = '';
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Import a Search Console report" description="In Search Console: Performance → Search results → choose the date range (optionally Compare) → Export → Download CSV. Upload the zip, or its CSV files. Only the Web search type is accepted.">
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">Export (.zip or .csv)</span>
          <input ref={ref} type="file" multiple accept=".zip,.csv,text/csv,application/zip" aria-label="Search Console export files" className="text-sm" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">First day (only without Dates.csv)</span>
          <Input type="date" aria-label="First day of the report" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted text-xs">Last day</span>
          <Input type="date" aria-label="Last day of the report" value={end} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <Button variant="primary" loading={busy} onClick={() => void send()}>
          <Upload className="h-4 w-4" /> Import
        </Button>
      </div>
      {error ? (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
    </Card>
  );
}

export function SearchPerformance({ websites, initialSite }: { websites: { id: string; name: string }[]; initialSite: string | null }) {
  const toast = useToast();
  const [siteId, setSiteId] = useState(initialSite ?? websites[0]?.id ?? '');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!siteId) return;
    setError(null);
    try {
      setData(await api<Data>(`/api/search-performance?websiteId=${encodeURIComponent(siteId)}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [siteId]);
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  if (!websites.length) return <EmptyState title="No websites yet" description="Add a website first." />;
  const exportUrl = (view: string) => `/api/search-performance/${siteId}/export?view=${view}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Website</span>
          <Select aria-label="Website" value={siteId} onChange={(e) => setSiteId(e.target.value)} className="w-64">
            {websites.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </label>
        {data?.property ? <Chip tone="info">{data.property}</Chip> : null}
      </div>

      {error ? (
        <Alert tone="danger" title="Could not load">
          {error}{' '}
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            Retry
          </Button>
        </Alert>
      ) : null}
      {!data && !error ? <p className="text-muted text-sm">Loading…</p> : null}

      {data?.state === 'NOT_CONNECTED' ? (
        <Alert tone="warning" title="NOT CONNECTED">
          {data.site.name} has no Search Console property. Add it on the{' '}
          <Link className="underline" href={`/websites/${data.site.id}`}>
            website page
          </Link>{' '}
          (Settings → Search Console property, e.g. “sc-domain:example.com”). This page then accepts reports you export from Search Console; nothing is shown before that.
        </Alert>
      ) : null}

      {data?.state === 'NO_DATA' ? (
        <>
          <Alert tone="info" title="NO VERIFIED DATA">
            Nothing has been imported for {data.property} yet. No clicks, impressions or positions are shown until you import a report from Search Console.
          </Alert>
          <ImportForm websiteId={siteId} onDone={load} />
        </>
      ) : null}

      {data?.state === 'DATA' ? (
        <>
          <p className="text-muted text-xs">
            {data.timezoneNote} Data comes only from the reports imported below.
          </p>
          {data.trend?.trends.length ? (
            <div className="grid gap-4 lg:grid-cols-3">
              {data.trend.trends.map((t) => (
                <TrendCard key={t.days} t={t} />
              ))}
            </div>
          ) : (
            <Alert tone="info">No daily totals imported yet (Dates.csv), so there are no 7/28/90-day trends. Page and query tables come from the reports below.</Alert>
          )}

          {data.indexing ? (
            <Card title="Indexing" description="A request is not indexing. “Seen in search” means the page had impressions in an imported report; “confirmed by you” is what you recorded after checking in Search Console.">
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-muted text-xs">Published app articles</dt>
                  <dd className="text-lg font-semibold tabular-nums">{data.indexing.published}</dd>
                </div>
                <div>
                  <dt className="text-muted text-xs">Indexing requested</dt>
                  <dd className="text-lg font-semibold tabular-nums">{data.indexing.requested}</dd>
                </div>
                <div>
                  <dt className="text-muted text-xs">Indexed (confirmed by you)</dt>
                  <dd className="text-lg font-semibold tabular-nums">{data.indexing.confirmedByOwner}</dd>
                </div>
                <div>
                  <dt className="text-muted text-xs">Seen in search</dt>
                  <dd className="text-lg font-semibold tabular-nums">{data.indexing.seenInSearch}</dd>
                </div>
              </dl>
            </Card>
          ) : null}

          <div className="grid gap-6 xl:grid-cols-2">
            <Card
              title={`Declining pages (${data.declining?.length ?? 0})`}
              description={`At least 10 clicks before and at most 70 % of them now.${data.pagesReport && !data.pagesReport.compare ? ' Needs a Compare export, or an earlier report of the same length.' : ''}`}
              actions={
                <a className="inline-flex items-center gap-1 text-sm text-indigo-600 underline" href={exportUrl('declining')}>
                  <Download className="h-3.5 w-3.5" /> CSV
                </a>
              }
            >
              {data.declining?.length ? (
                <ul className="space-y-2 text-sm">
                  {data.declining.map((d) => (
                    <li key={d.url} className="flex flex-wrap items-baseline gap-2">
                      {d.taskId ? (
                        <Link className="underline" href={`/articles/${d.taskId}`}>
                          {d.title ?? shortUrl(d.url)}
                        </Link>
                      ) : (
                        <span className="break-all">{shortUrl(d.url)}</span>
                      )}
                      <span className="tabular-nums">
                        {d.clicks} clicks (was {d.prevClicks}) {change(d.changePct)}
                      </span>
                      <span className="text-muted text-xs">vs {d.basis}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted text-sm">None in the imported data.</p>
              )}
            </Card>
            <Card
              title={`Published articles without impressions (${data.zero?.length ?? 0})`}
              description={`App articles published at least 14 days before the report ended.${data.pagesReport?.capped ? ' The page report lists 1,000 pages, the export limit: articles missing from it are not counted.' : ''}`}
              actions={
                <a className="inline-flex items-center gap-1 text-sm text-indigo-600 underline" href={exportUrl('zero')}>
                  <Download className="h-3.5 w-3.5" /> CSV
                </a>
              }
            >
              {data.zero?.length ? (
                <ul className="space-y-2 text-sm">
                  {data.zero.map((z) => (
                    <li key={z.taskId}>
                      <Link className="underline" href={`/articles/${z.taskId}`}>
                        {z.title}
                      </Link>{' '}
                      <span className="text-muted text-xs">{z.detail}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted text-sm">None in the imported data.</p>
              )}
            </Card>
          </div>

          <Card
            title={`Pages${data.pagesReport ? ` · ${data.pagesReport.start} – ${data.pagesReport.end}` : ''}`}
            padded={false}
            actions={
              <a className="inline-flex items-center gap-1 text-sm text-indigo-600 underline" href={exportUrl('pages')}>
                <Download className="h-3.5 w-3.5" /> CSV
              </a>
            }
          >
            {data.pages?.length ? (
              <div className="max-h-[28rem] overflow-auto">
                <table className="table-app">
                  <thead>
                    <tr>
                      <th>Page</th>
                      <th>Clicks</th>
                      <th>Impressions</th>
                      <th>CTR</th>
                      <th>Position</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.pages.slice(0, 100).map((p) => (
                      <tr key={p.key}>
                        <td className="max-w-md break-all">
                          {p.taskId ? (
                            <Link className="underline" href={`/articles/${p.taskId}`}>
                              {p.title}
                            </Link>
                          ) : (
                            shortUrl(p.key)
                          )}
                        </td>
                        <td className="tabular-nums">{n(p.clicks)}</td>
                        <td className="tabular-nums">{n(p.impressions)}</td>
                        <td className="tabular-nums">{p.ctr == null ? '—' : `${p.ctr} %`}</td>
                        <td className="tabular-nums">{n(p.position, 1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState title="No page report imported" description="Include Pages.csv in the import." />
            )}
          </Card>

          <Card
            title={`Queries${data.queriesReport ? ` · ${data.queriesReport.start} – ${data.queriesReport.end}` : ''}`}
            padded={false}
            actions={
              <a className="inline-flex items-center gap-1 text-sm text-indigo-600 underline" href={exportUrl('queries')}>
                <Download className="h-3.5 w-3.5" /> CSV
              </a>
            }
          >
            {data.queries?.length ? (
              <div className="max-h-[28rem] overflow-auto">
                <table className="table-app">
                  <thead>
                    <tr>
                      <th>Query</th>
                      <th>Clicks</th>
                      <th>Impressions</th>
                      <th>CTR</th>
                      <th>Position</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.queries.slice(0, 100).map((q) => (
                      <tr key={q.key}>
                        <td>{q.key}</td>
                        <td className="tabular-nums">{n(q.clicks)}</td>
                        <td className="tabular-nums">{n(q.impressions)}</td>
                        <td className="tabular-nums">{q.ctr == null ? '—' : `${q.ctr} %`}</td>
                        <td className="tabular-nums">{n(q.position, 1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState title="No query report imported" description="Include Queries.csv in the import." />
            )}
          </Card>

          <ImportForm websiteId={siteId} onDone={load} />
        </>
      ) : null}

      {data && data.snapshots.length ? (
        <Card title={`Imported reports (${data.snapshots.length})`}>
          <ul className="space-y-2 text-sm">
            {data.snapshots.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {s.startDate} – {s.endDate}
                </span>
                {s.compare ? <Chip tone="info">with comparison</Chip> : null}
                <span className="text-muted">
                  {s.pageRows} pages · {s.queryRows} queries · {s.dateRows} days · {s.fileName} · imported {formatDateTime(s.importedAt)}
                </span>
                {s.notes.length ? <span className="text-xs text-amber-700 dark:text-amber-300">{s.notes.join(' ')}</span> : null}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove the report ${s.startDate} – ${s.endDate}`}
                  onClick={async () => {
                    try {
                      await api(`/api/search-performance/imports/${s.id}`, { method: 'DELETE' });
                      toast('success', 'Report removed.');
                      await load();
                    } catch (e) {
                      toast('error', (e as Error).message);
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
