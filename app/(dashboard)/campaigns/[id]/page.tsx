import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { CampaignDetail } from './detail';
import { BackLink } from '@/components/nav-trail';

export const metadata = { title: 'Campaign' };

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <PageHeader
        title="Campaign"
        description={
          <>
            <BackLink fallbackHref="/campaigns" fallbackLabel="All campaigns" className="link" />
          </>
        }
      />
      <CampaignDetail id={id} />
    </>
  );
}
