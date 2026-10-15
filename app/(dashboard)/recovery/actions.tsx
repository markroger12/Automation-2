'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client/api';
import { Button, useToast } from '@/components/client';

export function IncidentActions({ id, hasTask }: { id: string; hasTask: boolean }) {
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (action: 'resolve' | 'dismiss' | 'resume-task' | 'retry-task') => {
    const note = action === 'resolve' ? (window.prompt('What did you verify? (saved with the incident)') ?? undefined) : undefined;
    if (action === 'resolve' && note === undefined) return;
    setBusy(action);
    try {
      await api(`/api/recovery/${id}`, { body: { action, note } });
      toast('success', 'Incident updated.');
      router.refresh();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {hasTask ? (
        <>
          <Button size="sm" onClick={() => void run('resume-task')} loading={busy === 'resume-task'} title="Resume from the saved checkpoint (no reset)">
            Resume from stage
          </Button>
          <Button size="sm" onClick={() => void run('retry-task')} loading={busy === 'retry-task'}>
            Retry
          </Button>
        </>
      ) : null}
      <Button size="sm" variant="ghost" onClick={() => void run('resolve')} loading={busy === 'resolve'}>
        Mark verified
      </Button>
      <Button size="sm" variant="ghost" onClick={() => void run('dismiss')} loading={busy === 'dismiss'}>
        Dismiss
      </Button>
    </div>
  );
}

/** A task running with no update for a long time: continue from its saved checkpoint (nothing is reset). */
export function StalledTaskActions({ taskId, stage }: { taskId: string; stage: string | null }) {
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      loading={busy}
      title="Continue from the saved checkpoint; finished stages are not repeated"
      onClick={async () => {
        setBusy(true);
        try {
          await api(`/api/tasks/${taskId}/resume`, { method: 'POST' });
          toast('success', `Resuming${stage ? ` from ${stage}` : ''}.`);
          router.refresh();
        } catch (e) {
          toast('error', (e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      Resume{stage ? ` from ${stage}` : ''}
    </Button>
  );
}
