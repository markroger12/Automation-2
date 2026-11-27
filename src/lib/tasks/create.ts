import { defaultSeoBrief } from '@/lib/seo/intent';
import { z } from 'zod';
import type { ArticleTask } from '@prisma/client';
import { db, type Tx } from '../db';
import { activeModuleKeySchema, countrySchema, languageSchema, moduleDisplayName, normalizeKeyword, type TaskSource } from '../domain';
import { findRuleCategory, missingRuleCategoryMessage } from '../celebrity-category';
import { categoryRuleFor } from '../writers/rules';
import { isCustomKey } from '../writers/types';
import { ensureCustomWriters } from '../writers/store';
import { taskOptionsSchema } from '../settings-schema';
import { MAX_SECONDARY_KEYWORDS, parseSecondaryKeywords } from '../content/text';
import { AppError } from '../errors';
import { ensureArticleRun } from './lifecycle';
import { log } from '../log';

const optionalTrimmed = (max: number) =>
  z
    .string()
    .max(max * 2)
    .optional()
    .nullable()
    .transform((v) => (v ?? '').replace(/\s+/g, ' ').trim() || null)
    .refine((v) => v === null || v.length <= max, `Must be at most ${max} characters`);

/** Shared input contract for Single Article, bulk rows and workflow keywords. */
export const articleTaskInputSchema = z.object({
  moduleKey: activeModuleKeySchema,
  keyword: z
    .string({ error: 'Primary keyword is required' })
    .transform((v) => v.replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(2, 'Primary keyword must be at least 2 characters').max(160, 'Primary keyword must be at most 160 characters')),
  secondaryKeywords: z
    .union([z.string().max(6000), z.array(z.string().max(160)).max(60)])
    .optional()
    .nullable()
    .transform((v) => parseSecondaryKeywords(v ?? []))
    .refine((v) => v.length <= MAX_SECONDARY_KEYWORDS, `At most ${MAX_SECONDARY_KEYWORDS} secondary keywords`),
  exampleTitle: optionalTrimmed(200),
  websiteId: z.string({ error: 'Choose a website' }).min(1, 'Choose a website').max(40),
  categoryId: z.string().max(40).optional().nullable(),
  language: languageSchema.optional().nullable(),
  targetCountry: countrySchema.optional().nullable(),
  options: taskOptionsSchema.prefault({}),
  priority: z.number().int().min(-10).max(10).default(0),
  idempotencyKey: z.string().min(8).max(120),
});
export type ArticleTaskInput = z.input<typeof articleTaskInputSchema>;

export interface CreateContext {
  source: TaskSource;
  campaignId?: string | null;
  campaignRowId?: string | null;
  workflowKeywordId?: string | null;
  benchmarkRunId?: string | null;
  routeDecision?: Record<string, unknown>;
  enqueue?: boolean;
}

/**
 * Create ONE ArticleTask with all input snapshots, then exactly one article
 * job. Re-submitting the same idempotency key returns the existing task.
 */
export async function createArticleTask(raw: unknown, ctx: CreateContext, client: Tx = db): Promise<{ task: ArticleTask; created: boolean }> {
  // One of the owner's writers: know it (and whether it is active) before checking the input.
  if (isCustomKey((raw as { moduleKey?: string } | null)?.moduleKey)) await ensureCustomWriters();
  const input = articleTaskInputSchema.parse(raw);
  const existing = await client.articleTask.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return { task: existing, created: false };

  const site = await client.website.findUnique({ where: { id: input.websiteId }, include: { categories: true } });
  if (!site) throw new AppError(400, 'VALIDATION', 'The selected website does not exist.', { websiteId: ['Unknown website'] });
  if (!site.active) throw new AppError(400, 'VALIDATION', `${site.name} is inactive. Activate it on the Websites page first.`, { websiteId: ['Website is inactive'] });

  const language = input.language ?? (site.language as 'en' | 'de');
  let category: (typeof site.categories)[number] | undefined;
  const rule = categoryRuleFor(input.moduleKey);
  if (rule.mode !== 'chatgpt') {
    // Owner decision (2026-11-04): celebrity articles always go into the website's “Celebrity” category (German
    // websites: “Prominente”); the owner's writers may always use another fixed category. A chosen one is not used.
    category = findRuleCategory(site.categories, rule, language) ?? undefined;
    if (!category) throw new AppError(400, 'VALIDATION', missingRuleCategoryMessage(site.name, rule, language, moduleDisplayName(input.moduleKey)), { categoryId: [rule.mode === 'celebrity' ? 'No Celebrity category on this website' : `No “${rule.name}” category on this website`] });
  } else {
    category = input.categoryId ? site.categories.find((c) => c.id === input.categoryId) : undefined;
    if (input.categoryId && !category) throw new AppError(400, 'VALIDATION', 'That category does not belong to the selected website.', { categoryId: ['Not a synchronized category of this site'] });
    // Tigram without a chosen category: its CATEGORY stage chooses one (with the default as the fallback).
  }

  const country = input.targetCountry ?? site.targetCountry;
  try {
    const task = await client.articleTask.create({
      data: {
        moduleKey: input.moduleKey,
        websiteId: site.id,
        categoryId: category?.id ?? null,
        categoryName: category?.name ?? null,
        categoryExternalId: category?.externalId ?? null,
        keyword: input.keyword,
        normalizedKeyword: normalizeKeyword(input.keyword),
        exampleTitle: input.exampleTitle,
        secondaryKeywords: JSON.stringify(input.secondaryKeywords),
        language,
        targetCountry: country,
        options: JSON.stringify(input.options),
        priority: input.priority + site.priority,
        idempotencyKey: input.idempotencyKey,
        source: ctx.source,
        campaignId: ctx.campaignId ?? null,
        campaignRowId: ctx.campaignRowId ?? null,
        workflowKeywordId: ctx.workflowKeywordId ?? null,
        benchmarkRunId: ctx.benchmarkRunId ?? null,
        routeDecision: JSON.stringify(ctx.routeDecision ?? { source: 'manual', moduleKey: input.moduleKey }),
        seoBrief: JSON.stringify(defaultSeoBrief({ keyword: input.keyword, secondary: input.secondaryKeywords, moduleKey: input.moduleKey, language })),
        message: 'Queued — waiting for a free article slot.',
      },
    });
    if (ctx.enqueue !== false) await ensureArticleRun(task.id, `created:${ctx.source}`, client);
    await log({ category: 'task', taskId: task.id, message: `Task created (${ctx.source}) for "${task.keyword}" on ${site.name} with ${input.moduleKey}.` }, client);
    return { task, created: true };
  } catch (error) {
    // Concurrent double-submit with the same key: return the winner.
    const winner = await client.articleTask.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (winner) return { task: winner, created: false };
    throw error;
  }
}
