'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download, HardDrive } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, useToast } from '@/components/client';
import { buttonClasses } from '@/components/ui';

export function DiagnosticsActions() {
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap gap-2">
      <a className={buttonClasses('secondary')} href="/api/diagnostics/bundle">
        <Download className="h-4 w-4" /> Download diagnostic bundle
      </a>
      <Button
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const res = await api<{ name: string }>('/api/diagnostics/backup', { body: { media: true } });
            toast('success', `Backup created: ${res.name}`);
            router.refresh();
          } catch (error) {
            toast('error', (error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <HardDrive className="h-4 w-4" /> Back up database + media
      </Button>
    </div>
  );
}
