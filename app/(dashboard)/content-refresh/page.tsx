import { NotBuilt } from '@/components/not-built';

export const metadata = { title: 'Content Refresh' };

export default function ContentRefreshPage() {
  return <NotBuilt title={'Content Refresh'} milestone={'M15'} description={'Reviewable refresh candidates and revisions.'} />;
}
