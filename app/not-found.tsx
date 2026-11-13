import Link from 'next/link';

export const metadata = { title: 'Page not found' };

/** An address the dashboard does not have (owner QA report: the plain Next.js 404 page). */
export default function NotFound() {
  return (
    <div className="grid min-h-screen place-items-center bg-[var(--bg)] px-4">
      <div className="surface border-app w-full max-w-md rounded-xl border p-6 text-center">
        <div className="text-muted text-sm font-medium">404</div>
        <h1 className="mt-1 text-xl font-semibold">This page does not exist</h1>
        <p className="text-muted mt-2 text-sm">The address may be mistyped, or the page has moved. Everything else works as usual.</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Link href="/" className="inline-flex h-9 items-center rounded-md bg-[var(--primary)] px-4 text-sm font-medium text-[var(--primary-fg)] hover:opacity-90">
            Go to the Overview
          </Link>
          <Link href="/help" className="border-app inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-[var(--surface-2)]">
            Help / Setup
          </Link>
        </div>
      </div>
    </div>
  );
}
