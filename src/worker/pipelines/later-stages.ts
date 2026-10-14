import type { StageManifest } from '@/modules/types';
import type { PipelineStage } from '../pipeline/types';
import { notAvailableYet, stageFrom } from './common';
import { rankMath, verifiedComplete, wordpressDraft } from './wordpress';
import { externalLinks, internalLinks } from './links';

/**
 * Stages shared by both writers. Those implemented by later milestones are
 * SKIPPED with an explicit reason (never faked) until then.
 */
export function laterStages(stages: StageManifest[]): PipelineStage[] {
  const S = (key: string) => stageFrom(stages, key);
  return [
    externalLinks(S('EXTERNAL_LINKS')),
    internalLinks(S('INTERNAL_LINKS')),
    notAvailableYet(S('IMAGES'), 'Images are not available in this build yet (milestone M8).'),
    notAvailableYet(S('HUMANIZE'), 'The editorial humanizer is not available in this build yet (milestone M9).'),
    wordpressDraft(S('WORDPRESS_DRAFT')),
    rankMath(S('RANKMATH')),
    verifiedComplete(S('VERIFIED_COMPLETE')),
  ];
}
