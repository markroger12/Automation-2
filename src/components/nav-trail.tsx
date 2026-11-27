'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { pageLabelFor } from './nav-config';

const KEY = 'bas-nav-trail';
const MAX = 30;

function readTrail(): string[] {
  try {
    const t = JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Remembers the pages visited in this window (address and filters), for the “← back” links. Renders nothing. */
export function NavTrail() {
  const pathname = usePathname();
  const search = useSearchParams();
  useEffect(() => {
    const url = `${pathname}${search.size ? `?${search.toString()}` : ''}`;
    const trail = readTrail();
    // Filters changed on the same page: keep only the newest address of that page.
    if (trail.length && trail[trail.length - 1].split('?')[0] === pathname) trail.pop();
    trail.push(url);
    try {
      sessionStorage.setItem(KEY, JSON.stringify(trail.slice(-MAX)));
    } catch {
      /* storage unavailable: the links use their fallback */
    }
  }, [pathname, search]);
  return null;
}

/**
 * “← Workflow / Calendar”, “← Article History” …: back to the page this one was opened from, with its filters (owner
 * request 2026-11-13). Without such a page (opened directly, a new window): the fallback, e.g. Article Queue.
 */
export function BackLink({ fallbackHref, fallbackLabel, className = 'hover:underline' }: { fallbackHref: string; fallbackLabel: string; className?: string }) {
  const pathname = usePathname();
  const [back, setBack] = useState({ href: fallbackHref, label: fallbackLabel });
  useEffect(() => {
    const trail = readTrail();
    for (let i = trail.length - 1; i >= 0; i--) {
      const path = trail[i].split('?')[0];
      if (path === pathname) continue;
      const label = pageLabelFor(trail[i]);
      if (label) setBack({ href: trail[i], label });
      return;
    }
  }, [pathname]);
  return (
    <Link href={back.href} className={className}>
      ← {back.label}
    </Link>
  );
}
