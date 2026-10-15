import { websiteGrid, CLONE_FIELDS } from '@/lib/website-control';
import { PageHeader } from '@/components/ui';
import { WebsiteControl } from './control';

export const metadata = { title: 'Website Control' };
export const dynamic = 'force-dynamic';

export default async function WebsiteControlPage() {
  const websites = await websiteGrid();
  return (
    <>
      <PageHeader
        title="Website Control"
        description="Every website at a glance: its own WordPress profile, categories, templates, rules and publishing permission, with measured health. Pause a site, limit how many of its articles run at once, set its priority, check all sessions, or copy safe settings to other sites."
      />
      <WebsiteControl websites={websites} cloneFields={CLONE_FIELDS} />
    </>
  );
}
