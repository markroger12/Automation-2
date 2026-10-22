'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { Button, useToast } from './client';
import { Alert, Card, Chip } from './ui';
import { formatInZone } from '@/lib/workflow/time';

interface IndexingOverview {
  waiting: number;
  notSignedIn: number;
  quota: number;
  humanCheck: number;
  requested: number;
  signedIn: boolean | null;
  last: { url: string; outcome: string; at: string; message: string | null } | null;
  lastProof: { id: string; url: string | null; at: string } | null;
}

/**
 * “Request indexing” in Search Console, made by Automation Chrome after a publish (owner: “how do I know the request
 * was made? I never signed in to Search Console there”): what was requested, what waits and why, and the sign-in.
 */
export function IndexingPanel() {
  const toast = useToast();
  const [o, setO] = useState<IndexingOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setO(await api<IndexingOverview>('/api/search-console/indexing')), []);
  useEffect(() => {
    void load().catch(() => {});
    const t = setInterval(() => void load().catch(() => {}), 15_000);
    return () => clearInterval(t);
  }, [load]);
  async function act(action: 'signin' | 'now') {
    setBusy(true);
    try {
      const r = await api<{ count?: number }>('/api/search-console/indexing', { body: { action } });
      toast(
        'success',
        action === 'signin'
          ? 'Google sign-in opens in Automation Chrome. Sign in with the account that owns the Search Console property, then press “Request now”.'
          : r.count
            ? `${r.count} request(s) are made now (Automation Chrome opens Search Console for each, one after another).`
            : 'Nothing was waiting for a sign-in.',
      );
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!o) return null;
  const when = (iso: string) => `${formatInZone(iso, 'Asia/Karachi')} PK`;
  const needsSignIn = o.signedIn === false || o.notSignedIn > 0;
  return (
    <Card title="Indexing in Search Console" description="About 35 seconds after a publish, Automation Chrome opens the post in Search Console (URL Inspection) and clicks “Request indexing”, as you do by hand. The keyword then shows “indexing requested” and Google's answer.">
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={o.signedIn === true ? 'success' : needsSignIn ? 'warning' : 'neutral'}>
            {o.signedIn === true ? 'Google signed in (Automation Chrome)' : needsSignIn ? 'Google not signed in (Automation Chrome)' : 'Google sign-in not checked yet'}
          </Chip>
          <Chip tone="success">{o.requested} requested</Chip>
          {o.waiting ? <Chip tone="info">{o.waiting} waiting</Chip> : null}
          {o.quota ? <Chip tone="warning">{o.quota} after today's limit</Chip> : null}
        </div>
        {needsSignIn ? (
          <Alert tone="warning" title="Sign in to Google once in Automation Chrome">
            {o.notSignedIn ? `${o.notSignedIn} request(s) wait for it. ` : ''}Use the Google account that owns the website in Search Console. You type the password yourself in Chrome; the app never sees it. Then press “Request now” (or they are made within the hour).
          </Alert>
        ) : null}
        {o.humanCheck ? <Alert tone="warning">Google showed a check (“I'm not a robot”) in Automation Chrome; complete it there, then press “Request now”.</Alert> : null}
        {o.last ? (
          <p className="text-muted text-xs">
            Last answer: {o.last.outcome === 'REQUESTED' ? 'indexing requested' : o.last.outcome === 'NOT_SIGNED_IN' ? 'Google asked to sign in' : o.last.outcome === 'QUOTA' ? "Search Console's daily limit" : o.last.outcome.toLowerCase().replace('_', ' ')} for{' '}
            <a className="text-indigo-600 underline" href={o.last.url} target="_blank" rel="noreferrer">
              {o.last.url.replace(/^https?:\/\//, '')}
            </a>{' '}
            · {when(o.last.at)}
          </p>
        ) : (
          <p className="text-muted text-xs">No request made yet.</p>
        )}
        {o.lastProof ? (
          <div className="flex items-start gap-3">
            <a href={`/api/media/${o.lastProof.id}`} target="_blank" rel="noreferrer" className="shrink-0" title="Open the screenshot">
              <img src={`/api/media/${o.lastProof.id}`} alt="Search Console after “Request indexing” (latest)" className="border-app h-20 w-36 rounded border object-cover object-top" />
            </a>
            <p className="text-muted text-xs">
              Latest proof: Search Console as Automation Chrome saw it after “Request indexing”{o.lastProof.url ? ` for ${o.lastProof.url.replace(/^https?:\/\//, '')}` : ''} · {when(o.lastProof.at)}. Each keyword's own screenshot is linked in the keyword queue.
            </p>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void act('signin')}>
            Sign in to Google in Automation Chrome
          </Button>
          <Button size="sm" variant="secondary" disabled={busy || !o.waiting} onClick={() => void act('now')}>
            Request now
          </Button>
        </div>
      </div>
    </Card>
  );
}

