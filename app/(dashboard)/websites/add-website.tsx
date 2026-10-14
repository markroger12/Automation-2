'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/client';
import { Card } from '@/components/ui';
import { EMPTY_WEBSITE, WebsiteForm } from './website-form';

export function AddWebsite({ startOpen }: { startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const router = useRouter();
  if (!open) {
    return (
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" /> Add website
      </Button>
    );
  }
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/30 p-4 sm:p-10" role="dialog" aria-modal="true" aria-label="Add website">
      <div className="w-full max-w-3xl">
        <Card
          title="Add WordPress website"
          description="You will log in once in a visible browser window. Passwords are never asked for or stored."
          actions={
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          }
        >
          <WebsiteForm
            initial={EMPTY_WEBSITE}
            onSaved={(id) => {
              setOpen(false);
              router.push(`/websites/${id}`);
            }}
          />
        </Card>
      </div>
    </div>
  );
}
