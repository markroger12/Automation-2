import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { getExtensionHealth, getWorkerHealth } from '@/lib/health';
import { writerManifests } from '@/modules/registry';
import { ensureCustomWriters } from '@/lib/writers/store';
import { PageHeader } from '@/components/ui';
import { SingleArticleForm, type SiteOption } from './form';

export const metadata = { title: 'Single Article' };

export default async function SingleArticlePage() {
  await ensureCustomWriters();
  const [sites, settings, worker, extension] = await Promise.all([
    db.website.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      include: { wordpressProfile: { select: { sessionState: true } }, categories: { orderBy: { name: 'asc' }, select: { id: true, name: true } } },
    }),
    getSettings(),
    getWorkerHealth(),
    getExtensionHealth(),
  ]);
  const siteOptions: SiteOption[] = sites.map((s) => ({
    id: s.id,
    name: s.name,
    language: s.language === 'de' ? 'de' : 'en',
    targetCountry: s.targetCountry,
    session: s.wordpressProfile?.sessionState ?? 'UNKNOWN',
    paused: s.paused,
    defaultCategoryId: s.defaultCategoryId,
    categories: s.categories,
  }));
  return (
    <>
      <PageHeader
        title="Single Article"
        description="Write one article from a primary keyword. Secondary keywords and an example title are optional guidance. Everything you enter is saved with the task and shown in its prompts."
      />
      <SingleArticleForm
        sites={siteOptions}
        writers={writerManifests().map((m) => ({ key: m.key, name: m.name, description: m.description, highlights: m.highlights, exampleTitle: m.exampleTitle }))}
        defaults={{
          maxWords: settings.content.maxArticleWordCount,
          faqCount: settings.content.faqCount,
          tigramFaqCount: settings.content.tigramFaqCount,
          quickBioRows: settings.content.quickBioRows,
          reviewThreshold: settings.seo.reviewThreshold,
          rankMathTargetScore: settings.seo.rankMathTargetScore,
        }}
        health={{ worker: worker.state, extension: extension.state }}
      />
    </>
  );
}
