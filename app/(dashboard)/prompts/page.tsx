import { PageHeader } from '@/components/ui';
import { PromptManager } from './manager';

export const metadata = { title: 'Prompt Manager' };

export default async function PromptsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  return (
    <>
      <PageHeader
        title="Prompt Manager"
        description="One editable prompt per stage. Your edits are versioned and never overwritten by app updates. Text prompts automatically get an explicit language line when sent."
      />
      <PromptManager initialId={sp.id} />
    </>
  );
}
