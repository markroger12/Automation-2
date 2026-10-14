import type { PrismaClient } from '@prisma/client';
import { normalizeKeyword } from '@/lib/domain';

let counter = 0;

export async function createWebsite(client: PrismaClient, overrides: Partial<{ name: string; language: string; slug: string; paused: boolean; queueQuota: number; canPublish: boolean }> = {}) {
  counter++;
  const slug = overrides.slug ?? `site-${counter}-${Math.random().toString(36).slice(2, 7)}`;
  return client.website.create({
    data: {
      name: overrides.name ?? `Site ${counter}`,
      slug,
      publicUrl: `https://${slug}.example.test`,
      adminUrl: `https://${slug}.example.test/wp-admin/`,
      language: overrides.language ?? 'en',
      targetCountry: overrides.language === 'de' ? 'Germany' : 'United States',
      timezone: 'Europe/Berlin',
      paused: overrides.paused ?? false,
      queueQuota: overrides.queueQuota ?? 0,
      canPublish: overrides.canPublish ?? false,
    },
  });
}

export async function createTask(
  client: PrismaClient,
  websiteId: string,
  overrides: Partial<{ keyword: string; moduleKey: string; status: string; secondaryKeywords: string[]; exampleTitle: string | null; language: string; priority: number }> = {},
) {
  counter++;
  const keyword = overrides.keyword ?? `Keyword ${counter}`;
  return client.articleTask.create({
    data: {
      moduleKey: overrides.moduleKey ?? 'celebrity-writer',
      websiteId,
      keyword,
      normalizedKeyword: normalizeKeyword(keyword),
      secondaryKeywords: JSON.stringify(overrides.secondaryKeywords ?? []),
      exampleTitle: overrides.exampleTitle ?? null,
      targetCountry: overrides.language === 'de' ? 'Germany' : 'United States',
      language: overrides.language ?? 'en',
      status: overrides.status ?? 'QUEUED',
      priority: overrides.priority ?? 0,
      idempotencyKey: `test:${counter}:${Math.random().toString(36).slice(2)}`,
    },
  });
}
