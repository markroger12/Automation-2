/** Client-safe site health types and labels (see site-health.ts). */

export const HEALTH_KINDS = ['SESSION', 'REST', 'PERMISSIONS', 'EDITOR', 'RANK_MATH', 'DRAFT_SAVE', 'MEDIA_UPLOAD'] as const;
export type HealthKind = (typeof HEALTH_KINDS)[number];
export type HealthStatus = 'OK' | 'WARN' | 'FAIL';
export type OverallHealth = HealthStatus | 'UNKNOWN';

export const HEALTH_KIND_LABEL: Record<HealthKind, string> = {
  SESSION: 'Login session',
  REST: 'REST API',
  PERMISSIONS: 'Account permissions',
  EDITOR: 'Editor',
  RANK_MATH: 'Rank Math',
  DRAFT_SAVE: 'Draft saves',
  MEDIA_UPLOAD: 'Media uploads',
};

export interface HealthEntry {
  kind: HealthKind;
  status: HealthStatus;
  message: string;
  durationMs: number | null;
  taskId: string | null;
  at: string;
}

export interface SiteHealthSummary {
  websiteId: string;
  overall: OverallHealth;
  /** Why the overall status is not OK (empty when OK or UNKNOWN). */
  reasons: string[];
  latest: Partial<Record<HealthKind, HealthEntry>>;
  last24h: { draftSaves: number; draftFailures: number; uploads: number; uploadFailures: number; medianDraftSaveMs: number | null };
  sessionState: string | null;
  recent: HealthEntry[];
}
