import Link from 'next/link';
import { Download } from 'lucide-react';
import { productivityReport, TARGET_PER_HOUR, type BenchmarkClaim } from '@/lib/analytics/productivity';
import { Alert, Card, Chip, EmptyState, PageHeader, Stat, formatDateTime } from '@/components/ui';
import { RefreshButton } from './refresh-button';

export const metadata = { title: 'Productivity Analytics' };
export const dynamic = 'force-dynamic';

const CLAIM: Record<BenchmarkClaim, { tone: 'success' | 'danger' | 'warning' | 'neutral'; text: string }> = {
  PASS: { tone: 'success', text: 'PASS' },
  FAIL: { tone: 'danger', text: 'FAIL' },
  SUSPENDED: { tone: 'warning', text: 'claim suspended' },
  NO_WORK: { tone: 'neutral', text: 'no work to measure' },
};
const WRITER: Record<string, string> = { 'celebrity-writer': 'Celebrity Article Writer', 'tigram-writer': 'Tigram Article Writer', 'celebrity-writer-2': 'Celebrity Writer 2.0 (retired)' };
const sec = (ms: number | null) => (ms == null ? '—' : ms >= 120_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`);

export default async function ProductivityPage() {
  const r = await productivityReport();
  const maxDay = Math.max(1, ...r.days.map((d) => d.count));
  const hour = r.rolling.find((w) => w.minutes === 60)!;
  return (
    <>
      <PageHeader
        title="Productivity Analytics"
        description={`Counted from stored evidence only: a draft counts once, when its WordPress draft was read back and verified (post ID attached). Target: ${TARGET_PER_HOUR} verified drafts per hour.`}
        actions={<RefreshButton />}
      />
      {r.alerts.length ? (
        <div className="mb-6 space-y-2">
          {r.alerts.map((a, i) => (
            <Alert key={i} tone={a.level === 'critical' ? 'danger' : 'warning'}>
              {a.message}
            </Alert>
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {r.rolling.map((w) => (
          <Stat key={w.minutes} label={`Last ${w.minutes} min`} value={`${w.count} verified`} hint={`${w.perHour} per hour`} />
        ))}
        <Stat label="Last 7 days" value={`${r.week} verified`} hint={`${r.profile.highThroughput ? 'High-throughput' : 'Quality-first'} profile · ${r.profile.slots} article slot(s)${r.profile.adaptive ? ' (adaptive)' : ''}`} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card title="Target vs actual" description={`Two consecutive 60-minute windows ending now; ${TARGET_PER_HOUR} verified drafts needed in each.`}>
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={CLAIM[r.benchmark.claim].tone}>{CLAIM[r.benchmark.claim].text}</Chip>
              <span>{r.benchmark.explanation}</span>
            </div>
            <ul className="space-y-1">
              {r.benchmark.windows.map((w, i) => (
                <li key={i} className="tabular-nums">
                  {formatDateTime(w.from)} – {formatDateTime(w.to)}: <strong>{w.count}</strong> / {TARGET_PER_HOUR}
                </li>
              ))}
            </ul>
            <p className="text-muted">
              Last hour: {hour.count} of {TARGET_PER_HOUR}. Estimated capacity now: {r.capacityEstimate.perHour == null ? '—' : `${r.capacityEstimate.perHour} per hour`}. <span className="text-xs">{r.capacityEstimate.basis}</span>
            </p>
            <p className="text-muted text-xs">This is the dashboard view. The owner-authorized 2-hour live benchmark is run with real ChatGPT and WordPress sessions (RELEASE_CHECKLIST §4).</p>
          </div>
        </Card>
        <Card title="Verified drafts per day" description={`Last 14 days, ${r.timeZone} days.`}>
          {r.days.some((d) => d.count) ? (
            <ul className="space-y-1 text-xs" aria-label="Verified drafts per day">
              {r.days.map((d) => (
                <li key={d.day} className="flex items-center gap-2">
                  <span className="text-muted w-20 tabular-nums">{d.day.slice(5)}</span>
                  <span className="h-3 rounded bg-indigo-500" style={{ width: `${(d.count / maxDay) * 70}%` }} aria-hidden="true" />
                  <span className="tabular-nums">{d.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No verified drafts yet" description="Counts appear when articles finish with a verified WordPress draft." />
          )}
        </Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card title="By website (7 days)">
          {r.bySite.length ? (
            <ul className="space-y-1 text-sm">
              {r.bySite.map((s) => (
                <li key={s.websiteId} className="flex justify-between gap-2">
                  <Link className="underline" href={`/websites/${s.websiteId}`}>
                    {s.name}
                  </Link>
                  <span className="tabular-nums">{s.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted text-sm">None.</p>
          )}
        </Card>
        <Card title="By writer (7 days)">
          {r.byWriter.length ? (
            <ul className="space-y-1 text-sm">
              {r.byWriter.map((w) => (
                <li key={w.moduleKey} className="flex justify-between gap-2">
                  <span>{WRITER[w.moduleKey] ?? w.moduleKey}</span>
                  <span className="tabular-nums">{w.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted text-sm">None.</p>
          )}
        </Card>
        <Card title="By campaign (7 days)">
          {r.byCampaign.length ? (
            <ul className="space-y-1 text-sm">
              {r.byCampaign.map((c) => (
                <li key={c.campaignId ?? 'single'} className="flex justify-between gap-2">
                  {c.campaignId ? (
                    <Link className="underline" href={`/campaigns/${c.campaignId}`}>
                      {c.name}
                    </Link>
                  ) : (
                    <span>{c.name}</span>
                  )}
                  <span className="tabular-nums">{c.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted text-sm">None.</p>
          )}
        </Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card
          title="Slowest stages (7 days)"
          description={`Completed stage runs; time includes waiting for ChatGPT answers. Whole article: median ${r.articleMinutes.p50 ?? '—'} min, p90 ${r.articleMinutes.p90 ?? '—'} min (${r.articleMinutes.samples} articles).`}
          padded={false}
          actions={
            <a className="inline-flex items-center gap-1 px-2 text-sm text-indigo-600 underline" href="/api/productivity/export?view=stages">
              <Download className="h-3.5 w-3.5" /> CSV
            </a>
          }
        >
          {r.stages.length ? (
            <table className="table-app">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Runs</th>
                  <th>p50</th>
                  <th>p90</th>
                  <th>Retries</th>
                  <th>Failed</th>
                </tr>
              </thead>
              <tbody>
                {r.stages.slice(0, 15).map((s) => (
                  <tr key={s.stageKey}>
                    <td>{s.stageKey}</td>
                    <td className="tabular-nums">{s.count}</td>
                    <td className="tabular-nums">{sec(s.p50Ms)}</td>
                    <td className="tabular-nums">{sec(s.p90Ms)}</td>
                    <td className="tabular-nums">{s.retries}</td>
                    <td className="tabular-nums">{s.failed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState title="No stage timings yet" />
          )}
        </Card>
        <Card title="Waiting, review and quality">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-muted text-xs">ChatGPT limits (24 h)</dt>
              <dd className="tabular-nums">{r.chatgpt.limits24h}</dd>
            </div>
            <div>
              <dt className="text-muted text-xs">Time in ChatGPT backoff (total)</dt>
              <dd className="tabular-nums">{r.chatgpt.totalBackoffMinutes} min</dd>
            </div>
            <div>
              <dt className="text-muted text-xs">Needs review</dt>
              <dd className="tabular-nums">{r.review.needsReview}</dd>
            </div>
            <div>
              <dt className="text-muted text-xs">Awaiting your approval</dt>
              <dd className="tabular-nums">{r.review.awaitingApproval}</dd>
            </div>
            <div>
              <dt className="text-muted text-xs">Paused (login, checks, limits)</dt>
              <dd className="tabular-nums">{r.review.paused}</dd>
            </div>
            <div>
              <dt className="text-muted text-xs">Quality gate, 7 days</dt>
              <dd className="tabular-nums">
                {r.quality7d.PASS} pass · {r.quality7d.REVIEW} review · {r.quality7d.BLOCKED} blocked
              </dd>
            </div>
          </dl>
          {r.failureReasons.length ? (
            <>
              <h3 className="mt-4 text-sm font-medium">Top reasons articles stopped (7 days)</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {r.failureReasons.map((f) => (
                  <li key={f.reason} className="flex justify-between gap-3">
                    <span className="min-w-0 break-words">{f.reason}</span>
                    <span className="tabular-nums">{f.count}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </Card>
      </div>

      <Card
        className="mt-6"
        title="Verified drafts (proof)"
        description="Most recent first: each one is an article whose WordPress draft was read back and verified."
        padded={false}
        actions={
          <a className="inline-flex items-center gap-1 px-2 text-sm text-indigo-600 underline" href="/api/productivity/export?view=verified">
            <Download className="h-3.5 w-3.5" /> CSV
          </a>
        }
      >
        {r.recent.length ? (
          <table className="table-app">
            <thead>
              <tr>
                <th>Verified</th>
                <th>Article</th>
                <th>Website</th>
                <th>WordPress</th>
                <th>Minutes</th>
              </tr>
            </thead>
            <tbody>
              {r.recent.map((v) => (
                <tr key={v.taskId}>
                  <td className="text-xs whitespace-nowrap">{formatDateTime(v.verifiedAt)}</td>
                  <td>
                    <Link className="underline" href={`/articles/${v.taskId}`}>
                      {v.title}
                    </Link>
                  </td>
                  <td>{v.website}</td>
                  <td>{v.wpEditUrl ? <a className="underline" href={v.wpEditUrl} target="_blank" rel="noreferrer">#{v.wpPostId}</a> : v.wpPostId ? `#${v.wpPostId}` : '—'}</td>
                  <td className="tabular-nums">{v.minutes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title="No verified drafts in the last 14 days" />
        )}
      </Card>

      {r.versions.length > 1 ? (
        <Card className="mt-6" title="Stage time by app version (7 days)">
          <ul className="space-y-1 text-sm">
            {r.versions.map((v) => (
              <li key={v.version}>
                {v.version}: median stage {sec(v.p50Ms)} over {v.stages} runs
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
