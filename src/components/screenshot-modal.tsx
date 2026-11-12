'use client';

import { Download } from 'lucide-react';
import { Button, Modal } from './client';
import { buttonClasses } from './ui';

/**
 * A Search Console screenshot (proof of “Request indexing”) shown over the page (owner request: “it should not open in
 * a new tab, it should open in the same tab”). Close or Esc returns to the page as it was.
 */
export function ScreenshotModal({ shot, onClose }: { shot: { id: string; title: string; caption?: string } | null; onClose: () => void }) {
  return (
    <Modal
      open={Boolean(shot)}
      onClose={onClose}
      title={shot?.title ?? 'Search Console screenshot'}
      description={shot?.caption}
      width={1240}
      footer={
        shot ? (
          <>
            <a className={buttonClasses('secondary')} href={`/api/media/${shot.id}`} download={`search-console-${shot.id}.png`}>
              <Download className="h-4 w-4" aria-hidden /> Download
            </a>
            <Button variant="primary" onClick={onClose}>
              Close
            </Button>
          </>
        ) : null
      }
    >
      {shot ? <img src={`/api/media/${shot.id}`} alt={shot.title} className="border-app w-full rounded-md border" /> : null}
    </Modal>
  );
}
