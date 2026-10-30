import Link from 'next/link';
import { getSettings } from '@/lib/settings';
import { connectionKeyInfo } from '@/lib/agent/keys';
import { Card, PageHeader } from '@/components/ui';
import { ExtensionPairing } from '@/components/extension-pairing';
import { AppUpdates } from '@/components/app-updates';
import { updateInfo } from '@/lib/update/service';
import { SettingsForm } from './settings-form';

export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const [settings, key, update] = await Promise.all([getSettings(), connectionKeyInfo(), updateInfo()]);
  return (
    <>
      <PageHeader
        title="Settings"
        description="Global defaults. Website pages can override content/SEO/workflow values for their own tasks only. Each task freezes its effective configuration when it starts."
      />
      <AppUpdates initial={update} />
      <Card
        title="ChatGPT extension connection key"
        className="mb-6"
        description={
          <>
            The extension authenticates to this dashboard with this key. Full setup: <Link className="text-indigo-600 underline" href="/automation-chrome">Automation Chrome</Link>.
          </>
        }
      >
        <ExtensionPairing configured={key.configured} prefix={key.prefix} createdAt={key.createdAt} />
      </Card>
      <SettingsForm initial={settings} />
    </>
  );
}
