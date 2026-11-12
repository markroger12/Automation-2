import { PageHeader } from '@/components/ui';
import { SetupChecklist } from '@/components/setup-checklist';
import { setupState } from '@/lib/setup';

export const metadata = { title: 'Setup checklist' };
export const dynamic = 'force-dynamic';

export default async function SetupPage() {
  return (
    <>
      <PageHeader title="Setup checklist" description="What the app needs before the first article, ticked off by itself as each step works. Nothing here changes a setting." />
      <SetupChecklist initial={await setupState()} />
    </>
  );
}
