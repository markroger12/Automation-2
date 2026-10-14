import type { StageManifest } from '@/modules/types';
import type { PipelineStage } from '../pipeline/types';
import { notAvailableYet, stageFrom } from './common';

/**
 * Stages shared by both writers that are implemented by later milestones.
 * Until then they are SKIPPED with an explicit reason (never faked), and the
 * task ends in NEEDS_REVIEW instead of claiming completion.
 */
export function laterStages(stages: StageManifest[]): PipelineStage[] {
  const S = (key: string) => stageFrom(stages, key);
  return [
    notAvailableYet(S('EXTERNAL_LINKS'), 'External link verification is not available in this build yet (milestone M7).'),
    notAvailableYet(S('INTERNAL_LINKS'), 'Internal linking is not available in this build yet (milestone M7).'),
    notAvailableYet(S('IMAGES'), 'Images are not available in this build yet (milestone M8).'),
    notAvailableYet(S('HUMANIZE'), 'The editorial humanizer is not available in this build yet (milestone M9).'),
    notAvailableYet(S('WORDPRESS_DRAFT'), 'The WordPress draft step is not available in this build yet (milestone M6).'),
    notAvailableYet(S('RANKMATH'), 'Rank Math verification is not available in this build yet (milestone M6).'),
    notAvailableYet(S('VERIFIED_COMPLETE'), 'Verification requires a WordPress draft (milestone M6).'),
  ];
}
