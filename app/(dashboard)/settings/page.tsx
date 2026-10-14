import { getSettings } from '@/lib/settings';
import { PageHeader } from '@/components/ui';
import { SettingsForm } from './settings-form';

export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const settings = await getSettings();
  return (
    <>
      <PageHeader
        title="Settings"
        description="Global defaults. Website pages can override content/SEO/workflow values for their own tasks only. Each task freezes its effective configuration when it starts."
      />
      <SettingsForm initial={settings} />
    </>
  );
}
