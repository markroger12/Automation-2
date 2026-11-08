'use client';

import type { ReactNode } from 'react';
import { setCustomWriters } from '@/lib/writers/catalog';
import type { CustomWriterInfo } from '@/lib/writers/types';

/**
 * Hands the owner's writers (Writers → New writer) to the browser's catalog before any page below renders, so writer
 * names, person/general and category rules are known in every form and table without another request.
 */
export function WritersHydrator({ writers, children }: { writers: CustomWriterInfo[]; children: ReactNode }) {
  setCustomWriters(writers);
  return <>{children}</>;
}
