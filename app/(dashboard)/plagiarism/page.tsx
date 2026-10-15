import { PageHeader } from '@/components/ui';
import { PlagiarismPage } from './plagiarism';

export const metadata = { title: 'Plagiarism Evidence Checker' };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  return (
    <>
      <PageHeader
        title="Plagiarism Evidence Checker"
        description="Side-by-side matching passages with their sources: your saved articles, pages the text links to, your URLs, Wikipedia and (optionally) a licensed search API. Evidence for you to judge, never a verdict."
      />
      <PlagiarismPage initialTaskId={sp.task} initialCheckId={sp.check} />
    </>
  );
}
