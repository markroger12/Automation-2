'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Check, Clipboard, RotateCcw } from 'lucide-react';
import { reportClientError } from '@/lib/client/report-error';

/**
 * A page of the dashboard failed in the browser (owner report 2026-11-12). Instead of Next.js's bare “Application
 * error”, the menu and the top bar stay, and this says what happened, with Try again, Reload and the details to copy.
 * The error is also written to the app's log.
 */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    console.error('[page]', error);
    reportClientError(error, 'page');
  }, [error]);
  const details = [
    `Page: ${typeof window !== 'undefined' ? window.location.pathname : ''}`,
    `Error: ${error.name}: ${error.message}`,
    error.digest ? `Digest: ${error.digest}` : '',
    error.stack ? `Stack:\n${error.stack.split('\n').slice(0, 12).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <div className="mx-auto max-w-2xl py-10">
      <div className="surface border-app rounded-xl border p-6">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
            <AlertTriangle className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold">This page ran into a problem</h1>
            <p className="text-muted mt-1 text-sm">Your work is safe: articles, the queue and the worker keep running. Try again or reload the page. If it happens again, copy the details and send them to the developer; they are also in the app's log.</p>
            <p className="surface-2 mt-3 rounded-md px-3 py-2 font-mono text-xs break-words">{error.message || error.name}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={() => reset()} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--primary)] px-3 text-sm font-medium text-[var(--primary-fg)] hover:opacity-90">
                <RotateCcw className="h-4 w-4" aria-hidden /> Try again
              </button>
              <button type="button" onClick={() => window.location.reload()} className="border-app inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-[var(--surface-2)]">
                Reload the page
              </button>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(details)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false));
                }}
                className="border-app inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium hover:bg-[var(--surface-2)]"
              >
                {copied ? <Check className="h-4 w-4" aria-hidden /> : <Clipboard className="h-4 w-4" aria-hidden />} {copied ? 'Copied' : 'Copy details'}
              </button>
              <Link href="/" className="text-muted inline-flex h-9 items-center px-2 text-sm hover:underline">
                Go to the Overview
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
