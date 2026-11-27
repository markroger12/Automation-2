import { registerDataMigration } from './data-migrations';
import { RETIREMENT_MIGRATION_ID, retireCelebrityWriter2 } from './retirement';
import { SITE_OVERRIDES_MIGRATION_ID, unpinDefaultSiteOverrides } from './site-overrides-migration';
import { REVIEW_NOTES_MIGRATION_ID, reviewReasonsBecomeNotes } from './review-notes-migration';
import { HUMANIZER_DEFAULT_MIGRATION_ID, humanizerOffByDefault } from './humanizer-default-migration';
import { PHOTO_CHECK_MIGRATION_ID, celebrityPhotoCheckOn } from './photo-check-migration';
import { PUBLISHED_SLOT_MIGRATION_ID, publishedAtRealTime } from './published-slot-migration';

/** Built-in data migrations are registered here as milestones add them. */
export function loadBuiltInDataMigrations(): void {
  registerDataMigration({
    id: RETIREMENT_MIGRATION_ID,
    description: 'Retire Celebrity Writer 2.0: legacy records read-only, unfinished tasks to review, writer preferences moved to the Celebrity Article Writer (backup written first).',
    run: retireCelebrityWriter2,
  });
  registerDataMigration({
    id: SITE_OVERRIDES_MIGRATION_ID,
    description: 'Clear website setting overrides that were saved as the full set of shipped defaults (so global settings apply again); groups with any owner value are kept. Backup written first.',
    run: unpinDefaultSiteOverrides,
  });
  registerDataMigration({
    id: REVIEW_NOTES_MIGRATION_ID,
    description: 'Review system off by default: articles held only for review reasons with a verified WordPress draft become COMPLETED; the reasons stay as notes (backup written first).',
    run: reviewReasonsBecomeNotes,
  });
  registerDataMigration({
    id: HUMANIZER_DEFAULT_MIGRATION_ID,
    description: 'Humanizer off by default: the global switch is turned off once; websites set to On keep it.',
    run: humanizerOffByDefault,
  });
  registerDataMigration({
    id: PHOTO_CHECK_MIGRATION_ID,
    description: 'Celebrity photo check on by default (as in the earlier tool): the global switch and unfinished celebrity articles are switched on once, so collages of other sites are recognised and left out.',
    run: celebrityPhotoCheckOn,
  });
  registerDataMigration({
    id: PUBLISHED_SLOT_MIGRATION_ID,
    description: 'Published workflow articles show in the calendar when they were really published (not on a later slot they never used); that slot is free again. Backup written first.',
    run: publishedAtRealTime,
  });
}
