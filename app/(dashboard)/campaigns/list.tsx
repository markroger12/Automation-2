'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Layers } from 'lucide-react';
import { api } from '@/lib/client/api';
import { RelativeTime } from '@/components/client';
import { Card, Chip, EmptyState, ProgressBar } from '@/components/ui';
import { CampaignStatusChip } from './shared';

interface Row {
  id: string;
  name: string;
  status: string;
  message: string | null;
  createdAt: string;
  website: { name: string };
  _count: { rows: number };
  progress: { queued: number; running: number; review: number; drafts: number; failed: number; cancelled: number; waiting: number };
}

export function CampaignList() {
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const r = await api<{ campaigns: Row[] }>('/api/campaigns');
        if (!stop) setRows(r.campaigns);
      } catch {
        /* the banner explains a stopped server */
      }
    };
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);
  if (rows === null) return <Card><p className="text-muted text-sm">Loading…</p></Card>;
  if (!rows.length)
    return (
      <Card>
        <EmptyState icon={<Layers className="h-8 w-8" />} title="No campaigns yet" description="Paste keywords (one per line, “keyword | secondary | title”, CSV or spreadsheet columns) to create your first campaign." />
      </Card>
    );
  return (
    <Card padded={false}>
      <table className="table-app">
        <thead>
          <tr>
            <th>Campaign</th>
            <th>Website</th>
            <th>Rows</th>
            <th>Progress</th>
            <th>Status</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const p = c.progress;
            const tasks = p.queued + p.running + p.review + p.drafts + p.failed + p.cancelled + p.waiting;
            const done = p.drafts + p.review + p.failed + p.cancelled;
            return (
              <tr key={c.id}>
                <td>
                  <Link className="font-medium link" href={`/campaigns/${c.id}`}>
                    {c.name}
                  </Link>
                  {c.message ? <div className="text-muted text-xs">{c.message}</div> : null}
                </td>
                <td>{c.website.name}</td>
                <td>{c._count.rows}</td>
                <td className="min-w-48">
                  <ProgressBar value={tasks ? (done / tasks) * 100 : 0} />
                  <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
                    <Chip tone="success">{p.drafts} drafts</Chip>
                    {p.running ? <Chip tone="info">{p.running} running</Chip> : null}
                    {p.queued ? <Chip>{p.queued} queued</Chip> : null}
                    {p.review ? <Chip tone="warning">{p.review} review</Chip> : null}
                    {p.failed ? <Chip tone="danger">{p.failed} failed</Chip> : null}
                  </div>
                </td>
                <td>
                  <CampaignStatusChip status={c.status} />
                </td>
                <td className="text-muted text-xs">
                  <RelativeTime value={c.createdAt} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
