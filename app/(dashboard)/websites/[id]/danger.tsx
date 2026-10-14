'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client/api';
import { Button, ConfirmDialog, useToast } from '@/components/client';

export function DangerZone({ websiteId, slug, taskCount }: { websiteId: string; slug: string; taskCount: number }) {
  const toast = useToast();
  const router = useRouter();
  const [dialog, setDialog] = useState<null | 'reset' | 'profile' | 'delete'>(null);
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      if (dialog === 'reset') {
        await api(`/api/websites/${websiteId}/actions`, { body: { action: 'reset-session', confirm: 'RESET' } });
        toast('success', 'Session reset queued. You will need to log in again.');
      } else if (dialog === 'profile') {
        await api(`/api/websites/${websiteId}/actions`, { body: { action: 'delete-profile', confirm: slug } });
        toast('success', 'Profile deletion queued.');
      } else if (dialog === 'delete') {
        await api(`/api/websites/${websiteId}`, { method: 'DELETE' });
        toast('success', 'Website removed. The browser profile folder was kept.');
        router.push('/websites');
        return;
      }
      router.refresh();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
      setDialog(null);
    }
  }
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-medium">Reset session</div>
          <div className="text-muted text-xs">Clears cookies and storage of this site’s profile. Folder is kept.</div>
        </div>
        <Button onClick={() => setDialog('reset')}>Reset session…</Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-medium">Delete browser profile</div>
          <div className="text-muted text-xs">Removes data/profiles/{slug}. Never done automatically.</div>
        </div>
        <Button variant="danger" onClick={() => setDialog('profile')}>Delete profile…</Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-medium">Remove website</div>
          <div className="text-muted text-xs">{taskCount > 0 ? `Not possible: ${taskCount} article(s) reference it. Deactivate instead.` : 'Allowed because no articles reference it.'}</div>
        </div>
        <Button variant="danger" disabled={taskCount > 0} onClick={() => setDialog('delete')}>Remove…</Button>
      </div>
      <ConfirmDialog
        open={dialog !== null}
        title={dialog === 'reset' ? 'Reset this WordPress session?' : dialog === 'profile' ? 'Delete the browser profile folder?' : 'Remove this website?'}
        tone="danger"
        confirmLabel="Confirm"
        requireText={dialog === 'profile' ? slug : dialog === 'delete' ? 'REMOVE' : undefined}
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => void run()}
      >
        {dialog === 'reset'
          ? 'You will be logged out of WordPress in this profile and must log in again manually.'
          : dialog === 'profile'
            ? 'All cookies and saved state for this site are permanently removed. Tasks for this site pause until you log in again.'
            : 'The website configuration and its synced categories are removed. The profile folder stays on disk.'}
      </ConfirmDialog>
    </div>
  );
}
