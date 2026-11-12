'use client';

import { useEffect } from 'react';
import { reportClientError } from '@/lib/client/report-error';

/**
 * The last safety net: an error in the dashboard's frame itself (menu, top bar). Instead of Next.js's bare
 * “Application error”, a calm page with Reload, and the error in the app's log. Plain styles: the app's stylesheet is
 * not loaded here.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('[app]', error);
    reportClientError(error, 'dashboard frame');
  }, [error]);
  const button = { height: 36, padding: '0 14px', borderRadius: 6, fontSize: 14, fontWeight: 500, cursor: 'pointer' } as const;
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#f4f4f5', color: '#18181b', fontFamily: '"Segoe UI", system-ui, sans-serif' }}>
        <div style={{ maxWidth: 520, margin: 16, padding: 24, background: '#fff', border: '1px solid #e4e4e7', borderRadius: 12 }}>
          <h1 style={{ margin: 0, fontSize: 18 }}>The dashboard ran into a problem</h1>
          <p style={{ margin: '8px 0 0', fontSize: 14, color: '#52525b' }}>Your work is safe: articles, the queue and the worker keep running. Reload the dashboard to go on. The details are in the app&apos;s log (Help → Troubleshooting → Open the log).</p>
          <p style={{ margin: '12px 0 0', padding: '8px 12px', background: '#f4f4f5', borderRadius: 6, fontFamily: 'Consolas, monospace', fontSize: 12, wordBreak: 'break-word' }}>{error.message || error.name}</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button type="button" onClick={() => window.location.reload()} style={{ ...button, border: 0, background: '#18181b', color: '#fff' }}>
              Reload the dashboard
            </button>
            <button type="button" onClick={() => reset()} style={{ ...button, border: '1px solid #e4e4e7', background: '#fff', color: '#18181b' }}>
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
