import Link from 'next/link';
import { getSettings } from '@/lib/settings';
import { connectionKeyInfo } from '@/lib/agent/keys';
import { Card, PageHeader } from '@/components/ui';
import { ExtensionPairing } from '@/components/extension-pairing';
import { AppUpdates } from '@/components/app-updates';
import { DesktopAppUpdates } from '@/components/desktop-updates';
import { AssistantSettingsCard } from '@/components/assistant-settings';
import { assistantSettings } from '@/lib/assistant/settings';
import { inDesktopApp } from '@/lib/runtime';
import { updateInfo } from '@/lib/update/service';
import { readAutoCheck } from '@/lib/update/auto-check';
import { SettingsForm } from './settings-form';

export const metadata = { title: 'Settings' };

export default async function SettingsPage() {
  // Inside the desktop app the app updates itself (its own card); git and its checks are for the npm copy only.
  const desktop = inDesktopApp();
  const [settings, key, update, autoCheck] = await Promise.all([getSettings(), connectionKeyInfo(), desktop ? null : updateInfo(), desktop ? null : readAutoCheck().catch(() => null)]);
  return (
    <>
      <PageHeader
        title="Settings"
        description="Global defaults. Website pages can override content/SEO/workflow values for their own tasks only. Each task freezes its effective configuration when it starts."
      />
      {update ? <AppUpdates initial={update} auto={autoCheck} /> : <DesktopAppUpdates version={process.env.BAS_APP_VERSION ?? null} />}
      <AssistantSettingsCard initial={assistantSettings()} />
      <Card
        title="ChatGPT extension connection key"
        className="mb-6"
        description={
          <>
            The extension authenticates to this dashboard with this key. Full setup: <Link className="link" href="/automation-chrome">Automation Chrome</Link>.
          </>
        }
      >
        <ExtensionPairing configured={key.configured} prefix={key.prefix} createdAt={key.createdAt} />
      </Card>
      <SettingsForm initial={settings} />
    </>
  );
}
