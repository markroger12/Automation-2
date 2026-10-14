import type { StageManifest } from '@/modules/types';
import type { PipelineStage } from '../pipeline/types';
import { stageFrom } from './common';
import { rankMath, verifiedComplete, wordpressDraft } from './wordpress';
import { externalLinks, internalLinks } from './links';
import { imagesStage } from './images';
import { humanizeStage } from './humanize';

/** Stages shared by both writers. */
export function laterStages(stages: StageManifest[]): PipelineStage[] {
  const S = (key: string) => stageFrom(stages, key);
  return [
    externalLinks(S('EXTERNAL_LINKS')),
    internalLinks(S('INTERNAL_LINKS')),
    imagesStage(S('IMAGES')),
    humanizeStage(S('HUMANIZE')),
    wordpressDraft(S('WORDPRESS_DRAFT')),
    rankMath(S('RANKMATH')),
    verifiedComplete(S('VERIFIED_COMPLETE')),
  ];
}
