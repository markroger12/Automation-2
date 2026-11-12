import type { ModuleManifest } from './types';
import { celebrityManifest } from './celebrity-writer/manifest';
import { celebrity2Manifest } from './celebrity2-writer/manifest';
import { tigramManifest } from './tigram-writer/manifest';
import { customManifest } from './custom/manifest';
import { activeCustomWriters, customWriter } from '@/lib/writers/catalog';

/**
 * Client-safe module registry: Celebrity, Celebrity 2 (owner request, 2026-11-04) and Tigram, plus the writers the
 * owner builds in the app (Writers → New writer; known through src/lib/writers/catalog.ts). Celebrity Writer 2.0 is
 * retired: it is not registered here, cannot be selected or queued, and survives only as an archival identifier on
 * historical records.
 */
export const ACTIVE_MODULES: readonly ModuleManifest[] = [celebrityManifest, celebrity2Manifest, tigramManifest];

/** A writer's steps: built-in, or one of the owner's writers (drafts and archived ones too, for their articles). */
export function getManifest(key: string): ModuleManifest | undefined {
  const builtIn = ACTIVE_MODULES.find((m) => m.key === key);
  if (builtIn) return builtIn;
  const custom = customWriter(key);
  return custom ? customManifest(custom) : undefined;
}

/** Every writer new articles can be started with: the built-in ones, then the owner's active writers. */
export function writerManifests(): ModuleManifest[] {
  return [...ACTIVE_MODULES, ...activeCustomWriters().map(customManifest)];
}

export function writerOptions(): { key: string; name: string; description: string }[] {
  return writerManifests().map((m) => ({ key: m.key, name: m.name, description: m.description }));
}
