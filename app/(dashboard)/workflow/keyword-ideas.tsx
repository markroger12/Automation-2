'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { api } from '@/lib/client/api';
import type { KeywordIdea } from '@/lib/workflow/keyword-ideas';
import { Button, Modal, Tabs, useToast } from '@/components/client';
import { Input } from '@/components/form';
import { Chip, cx } from '@/components/ui';

type Source = 'search-console' | 'google';

/**
 * Workflow → Keyword ideas (owner request): queries Search Console shows for this website that no keyword or article
 * covers yet, and Google's related searches / “People also ask” (Serper) for a seed. Ticked ideas go into the queue
 * through the same “Add keywords” path (duplicates left out, the writer detected as usual).
 */
export function KeywordIdeas({ open, onClose, siteId, seeds, onAdded }: { open: boolean; onClose: () => void; siteId: string; seeds: string[]; onAdded: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<Source>('search-console');
  const [gsc, setGsc] = useState<{ ideas: KeywordIdea[]; data: { source: string; startDate: string; endDate: string } | null } | null>(null);
  const [gscError, setGscError] = useState<string | null>(null);
  const [seed, setSeed] = useState('');
  const [google, setGoogle] = useState<KeywordIdea[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPicked(new Set());
    setGsc(null);
    setGscError(null);
    api<{ ideas: KeywordIdea[]; data: { source: string; startDate: string; endDate: string } | null }>(`/api/websites/${siteId}/workflow/ideas`)
      .then(setGsc)
      .catch((e) => setGscError((e as Error).message));
  }, [open, siteId]);

  async function find(q = seed) {
    if (!q.trim()) return;
    setSeed(q);
    setSearching(true);
    try {
      setGoogle((await api<{ ideas: KeywordIdea[] }>(`/api/websites/${siteId}/workflow/ideas`, { body: { seed: q } })).ideas);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setSearching(false);
    }
  }

  const toggle = (k: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  async function add() {
    setAdding(true);
    try {
      const r = await api<{ added: number; skippedDuplicates: number; invalid: number }>(`/api/websites/${siteId}/workflow/keywords`, { body: { text: [...picked].join('\n') } });
      toast('success', `${r.added} keyword(s) added to the queue${r.skippedDuplicates ? `, ${r.skippedDuplicates} already there` : ''}.`);
      setPicked(new Set());
      onAdded();
      onClose();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  const list = (ideas: KeywordIdea[], numbers: boolean) => (
    <div className="table-box max-h-[46vh] overflow-y-auto">
      <table className="table-app">
        <thead>
          <tr>
            <th className="w-8" aria-label="Pick" />
            <th>Keyword</th>
            {numbers ? (
              <>
                <th className="text-right">Impressions</th>
                <th className="text-right">Clicks</th>
                <th className="text-right">Avg. position</th>
              </>
            ) : (
              <th>From</th>
            )}
          </tr>
        </thead>
        <tbody>
          {ideas.map((i) => (
            <tr key={`${i.source}:${i.keyword}`} className={cx(i.covered && 'opacity-60')}>
              <td>
                <input type="checkbox" aria-label={`Pick ${i.keyword}`} disabled={i.covered} checked={picked.has(i.keyword)} onChange={() => toggle(i.keyword)} />
              </td>
              <td>
                <label className={cx(!i.covered && 'cursor-pointer')} onClick={() => !i.covered && toggle(i.keyword)}>
                  {i.keyword}
                </label>
                {i.covered ? <span className="text-muted ml-2 text-xs">already in the queue or written</span> : null}
              </td>
              {numbers ? (
                <>
                  <td className="text-right tabular-nums">{i.impressions?.toLocaleString('en-US')}</td>
                  <td className="text-right tabular-nums">{i.clicks?.toLocaleString('en-US')}</td>
                  <td className="text-right tabular-nums">{i.position != null ? i.position.toFixed(1) : '—'}</td>
                </>
              ) : (
                <td>
                  <Chip tone={i.source === 'related' ? 'neutral' : 'brand'}>{i.source === 'related' ? 'related search' : 'people also ask'}</Chip>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={900}
      title="Keyword ideas"
      description="What people search for, from Search Console and Google. Tick the ones to write; they join the end of the queue."
      footer={
        <>
          <span className="text-muted mr-auto text-xs">{picked.size ? `${picked.size} picked` : 'Nothing picked yet'}</span>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" disabled={!picked.size} loading={adding} onClick={add}>
            <Plus className="h-4 w-4" /> Add {picked.size || ''} to queue
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Tabs
          value={tab}
          onChange={(id) => setTab(id as Source)}
          tabs={[
            { id: 'search-console', label: 'Search Console', badge: gsc?.ideas.length ? <Chip>{gsc.ideas.length}</Chip> : undefined },
            { id: 'google', label: 'Google suggestions', badge: google?.length ? <Chip>{google.length}</Chip> : undefined },
          ]}
        />
        {tab === 'search-console' ? (
          gscError ? (
            <p className="text-sm text-rose-600">{gscError}</p>
          ) : !gsc ? (
            <p className="text-muted text-sm">Loading…</p>
          ) : !gsc.data ? (
            <p className="text-muted text-sm">
              No Search Console data for this website yet. Connect Search Console or import an export in <Link className="underline" href="/search-performance">Search Performance</Link>.
            </p>
          ) : (
            <>
              <p className="text-muted text-xs">
                Searches that showed this website between {gsc.data.startDate} and {gsc.data.endDate} ({gsc.data.source === 'GSC_API' ? 'live from Search Console' : 'imported export'}) and that no keyword or article of the website has yet. Most impressions first.
              </p>
              {gsc.ideas.length ? list(gsc.ideas, true) : <p className="text-sm">Every search in the data already has a keyword or article.</p>}
            </>
          )
        ) : (
          <>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void find();
              }}
            >
              <Input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="A keyword, e.g. a person's name" aria-label="Keyword to search" />
              <Button type="submit" variant="primary" loading={searching} disabled={!seed.trim()}>
                <Search className="h-4 w-4" /> Find
              </Button>
            </form>
            {seeds.length ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted text-xs">From your queue:</span>
                {seeds.slice(0, 6).map((s) => (
                  <button key={s} type="button" className="surface-2 rounded-md px-2 py-0.5 text-xs hover:underline" onClick={() => void find(s)}>
                    {s}
                  </button>
                ))}
              </div>
            ) : null}
            <p className="text-muted text-xs">One Google search through Serper (one credit) per Find: its “related searches” and “People also ask”.</p>
            {google ? google.length ? list(google, false) : <p className="text-sm">Google showed no related searches for this keyword.</p> : null}
          </>
        )}
      </div>
    </Modal>
  );
}
