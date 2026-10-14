import Link from 'next/link';
import { Plus } from 'lucide-react';
import { PageHeader, buttonClasses } from '@/components/ui';
import { CampaignList } from './list';

export const metadata = { title: 'Bulk Campaigns' };

export default function CampaignsPage() {
  return (
    <>
      <PageHeader
        title="Bulk Campaigns"
        description="Import up to 1,000 keywords at once. Each row becomes the same standard article task as Single Article — previewed, de-duplicated and routed to one of the two writers first. Campaigns never publish anything."
        actions={
          <Link href="/campaigns/new" className={buttonClasses('primary')}>
            <Plus className="h-4 w-4" /> New campaign
          </Link>
        }
      />
      <CampaignList />
    </>
  );
}
