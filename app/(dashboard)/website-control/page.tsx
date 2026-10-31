import { websiteGrid, CLONE_FIELDS } from '@/lib/website-control';
import { WebsiteControl } from './control';

export const metadata = { title: 'Website Control' };
export const dynamic = 'force-dynamic';

export default async function WebsiteControlPage() {
  const websites = await websiteGrid();
  return (
    <WebsiteControl
      websites={websites}
      cloneFields={CLONE_FIELDS}
      description="Every website at a glance: its WordPress session, categories, templates, rules and publishing permission, with measured health. Pause a site, set its priority and how many of its articles run at once, check all sessions, or copy safe settings to other sites."
    />
  );
}
