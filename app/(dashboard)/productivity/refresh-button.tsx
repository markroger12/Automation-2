'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/client';

/** Re-read the measurements (the page is computed on the server from stored evidence). */
export function RefreshButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button size="sm" loading={pending} onClick={() => start(() => router.refresh())}>
      <RefreshCw className="h-4 w-4" /> Refresh
    </Button>
  );
}
