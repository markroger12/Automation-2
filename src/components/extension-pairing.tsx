'use client';

import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, ConfirmDialog, CopyButton, useToast } from './client';
import { Alert } from './ui';

/** Create/rotate the extension connection key. The key is shown exactly once. */
export function ExtensionPairing({ configured, prefix, createdAt, onChanged }: { configured: boolean; prefix: string | null; createdAt: string | null; onChanged?: () => void }) {
  const toast = useToast();
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  async function create() {
    setBusy(true);
    try {
      const res = await api<{ key: string }>('/api/extension/key', { method: 'POST' });
      setKey(res.key);
      onChanged?.();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  }
  return (
    <div className="space-y-3">
      {key ? (
        <Alert tone="warning" title="Copy this connection key now — it will not be shown again">
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="surface rounded border px-2 py-1 text-xs break-all">{key}</code>
            <CopyButton text={key} label="Copy key" />
          </div>
          <p className="mt-2 text-xs">Paste it into the extension popup (puzzle icon → Blog Automation Studio) and click “Save &amp; connect”.</p>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {configured ? (
          <span>
            Key <code>{prefix}…</code> created {createdAt ? new Date(createdAt).toLocaleString() : ''}. Only its hash is stored.
          </span>
        ) : (
          <span className="text-muted">No connection key yet.</span>
        )}
        <Button variant={configured ? 'secondary' : 'primary'} loading={busy} onClick={() => (configured ? setConfirm(true) : void create())}>
          <KeyRound className="h-4 w-4" /> {configured ? 'Rotate key…' : 'Create connection key'}
        </Button>
      </div>
      <ConfirmDialog open={confirm} title="Rotate the connection key?" confirmLabel="Rotate" tone="danger" busy={busy} onCancel={() => setConfirm(false)} onConfirm={() => void create()}>
        Extensions paired with the old key stop working until you paste the new key into them.
      </ConfirmDialog>
    </div>
  );
}
