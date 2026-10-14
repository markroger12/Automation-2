import type { ModuleManifest } from './types';
import { celebrityManifest } from './celebrity-writer/manifest';
import { tigramManifest } from './tigram-writer/manifest';

/**
 * Client-safe module registry. EXACTLY two active writers. Celebrity Writer
 * 2.0 is retired: it is not registered here, cannot be selected or queued,
 * and survives only as an archival identifier on historical records.
 */
export const ACTIVE_MODULES: readonly ModuleManifest[] = [celebrityManifest, tigramManifest];

export function getManifest(key: string): ModuleManifest | undefined {
  return ACTIVE_MODULES.find((m) => m.key === key);
}

export function writerOptions(): { key: string; name: string; description: string }[] {
  return ACTIVE_MODULES.map((m) => ({ key: m.key, name: m.name, description: m.description }));
}
