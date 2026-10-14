import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { CampaignDetail } from './detail';

export const metadata = { title: 'Campaign' };

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <>
      <PageHeader
        title="Campaign"
        description={
          <>
            <Link href="/campaigns" className="text-indigo-600 underline">
              ← All campaigns
            </Link>
          </>
        }
      />
      <CampaignDetail id={id} />
    </>
  );
}
