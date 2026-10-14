import { PageHeader } from '@/components/ui';
import { AutomationChromeWizard } from './wizard';

export const metadata = { title: 'Automation Chrome' };

export default function AutomationChromePage() {
  return (
    <>
      <PageHeader
        title="Automation Chrome"
        description="ChatGPT runs in a dedicated, visible Chrome profile with the Blog Automation Studio extension and YOUR own ChatGPT sign-in. No API keys, no hidden automation, no CAPTCHA solving."
      />
      <AutomationChromeWizard />
    </>
  );
}
