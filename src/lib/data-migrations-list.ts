import { registerDataMigration } from './data-migrations';
import { RETIREMENT_MIGRATION_ID, retireCelebrityWriter2 } from './retirement';
import { SITE_OVERRIDES_MIGRATION_ID, unpinDefaultSiteOverrides } from './site-overrides-migration';

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
}
