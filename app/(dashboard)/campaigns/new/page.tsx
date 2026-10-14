import { PageHeader } from '@/components/ui';
import { NewCampaign } from './new-campaign';

export const metadata = { title: 'New campaign' };

export default function NewCampaignPage() {
  return (
    <>
      <PageHeader title="New campaign" description="Paste or load keywords, preview how each row is routed and de-duplicated, correct what is unclear, then create the campaign." />
      <NewCampaign />
    </>
  );
}
