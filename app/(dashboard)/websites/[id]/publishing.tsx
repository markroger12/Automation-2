'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, ConfirmDialog, useToast } from '@/components/client';
import { Alert } from '@/components/ui';

const PHRASE = 'ALLOW PUBLISHING';

export function PublishingPermission({ websiteId, canPublish, allowLiveUpdates }: { websiteId: string; canPublish: boolean; allowLiveUpdates: boolean }) {
  const toast = useToast();
  const router = useRouter();
  const [dialog, setDialog] = useState<null | 'enable' | 'live'>(null);
  const [busy, setBusy] = useState(false);
  async function save(next: { canPublish: boolean; allowLiveUpdates?: boolean }) {
    setBusy(true);
    try {
      await api(`/api/websites/${websiteId}/publishing`, { method: 'PUT', body: { ...next, acknowledgement: PHRASE } });
      toast('success', next.canPublish ? 'Publishing permission updated.' : 'Publishing disabled — drafts only.');
      router.refresh();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
      setDialog(null);
    }
  }
  return (
    <div className="space-y-3">
      {canPublish ? (
        <Alert tone="danger" title="Scheduling/publishing is ENABLED for this site">
          Only the approved scheduler path may set a future/published state, after a fresh permission check. All other paths stay draft-only.
        </Alert>
      ) : (
        <Alert tone="success" title="Drafts only">
          No path can publish, schedule, set private or pending on this site. This is the safe default.
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        {canPublish ? (
          <Button variant="primary" loading={busy} onClick={() => void save({ canPublish: false })}>
            <ShieldCheck className="h-4 w-4" /> Disable publishing (drafts only)
          </Button>
        ) : (
          <Button variant="danger" onClick={() => setDialog('enable')}>
            <ShieldAlert className="h-4 w-4" /> Enable scheduled publishing…
          </Button>
        )}
        {canPublish ? (
          allowLiveUpdates ? (
            <Button loading={busy} onClick={() => void save({ canPublish: true, allowLiveUpdates: false })}>
              Block updates to live posts
            </Button>
          ) : (
            <Button onClick={() => setDialog('live')}>Allow approved updates to live posts…</Button>
          )
        ) : null}
      </div>
      <ConfirmDialog
        open={dialog !== null}
        title={dialog === 'enable' ? 'Allow the scheduler to publish on this site?' : 'Allow approved content refreshes of live posts?'}
        tone="danger"
        confirmLabel="I understand — enable"
        requireText={PHRASE}
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => void save(dialog === 'enable' ? { canPublish: true } : { canPublish: true, allowLiveUpdates: true })}
      >
        {dialog === 'enable'
          ? 'Only workflow slots you configure will schedule EXISTING verified drafts at the site-local time. Single articles, bulk campaigns, retries, the humanizer and regeneration remain draft-only. This change is audited.'
          : 'Approved refresh revisions may update content of already published posts while preserving status, date and URL. Each update still needs your approval. This change is audited.'}
      </ConfirmDialog>
    </div>
  );
}
