'use client';

import { Chip, type ChipTone } from '@/components/ui';

const CAMPAIGN: Record<string, [string, ChipTone]> = {
  QUEUEING: ['queueing rows', 'info'],
  ACTIVE: ['active', 'brand'],
  PAUSED: ['paused', 'warning'],
  COMPLETED: ['finished', 'success'],
  CANCELLED: ['cancelled', 'neutral'],
};
export function CampaignStatusChip({ status }: { status: string }) {
  const [label, tone] = CAMPAIGN[status] ?? [status.toLowerCase(), 'neutral'];
  return <Chip tone={tone}>{label}</Chip>;
}

const ROW: Record<string, [string, ChipTone]> = {
  READY: ['ready', 'success'],
  NEEDS_WRITER: ['choose writer', 'warning'],
  NEEDS_CATEGORY: ['choose category', 'warning'],
  DUPLICATE: ['duplicate?', 'warning'],
  INVALID: ['invalid', 'danger'],
  SKIPPED: ['excluded', 'neutral'],
  QUEUED: ['task created', 'brand'],
  CANCELLED: ['cancelled', 'neutral'],
};
export function RowStatusChip({ status }: { status: string }) {
  const [label, tone] = ROW[status] ?? [status.toLowerCase(), 'neutral'];
  return <Chip tone={tone}>{label}</Chip>;
}

export const WRITER_LABEL: Record<string, string> = { 'celebrity-writer': 'Celebrity', 'tigram-writer': 'Tigram' };
