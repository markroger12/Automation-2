import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../db';
import { DRAFT_STATUSES, PAUSED_STATUSES, REVIEW_STATUSES, RUNNING_STATUSES, statusGroup, type StatusGroup } from '../domain';
import { parseJson, stringArray } from '../json';

export const taskListQuerySchema = z.object({
  group: z.enum(['all', 'queued', 'running', 'review', 'paused', 'draft', 'failed', 'cancelled', 'active']).default('all'),
  websiteId: z.string().max(40).optional(),
  moduleKey: z.string().max(40).optional(),
  q: z.string().max(200).optional(),
  campaignId: z.string().max(40).optional(),
  source: z.string().max(20).optional(),
  sort: z.enum(['updated', 'created', 'keyword', 'status', 'seo']).default('updated'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  from: z.string().optional(),
  to: z.string().optional(),
});
export type TaskListQuery = z.output<typeof taskListQuerySchema>;

export function groupWhere(group: TaskListQuery['group']): Prisma.ArticleTaskWhereInput {
  switch (group) {
    case 'queued':
      return { status: 'QUEUED' };
    case 'running':
      return { status: { in: RUNNING_STATUSES } };
    case 'review':
      return { status: { in: REVIEW_STATUSES } };
    case 'paused':
      return { status: { in: PAUSED_STATUSES } };
    case 'draft':
      return { status: { in: DRAFT_STATUSES } };
    case 'failed':
      return { status: 'FAILED' };
    case 'cancelled':
      return { status: 'CANCELLED' };
    case 'active':
      return { status: { notIn: ['COMPLETED', 'CANCELLED', 'DRAFT_CREATED'] } };
    default:
      return {};
  }
}

export function taskWhere(query: TaskListQuery): Prisma.ArticleTaskWhereInput {
  const from = query.from ? new Date(query.from) : null;
  const to = query.to ? new Date(query.to) : null;
  return {
    ...groupWhere(query.group),
    ...(query.websiteId ? { websiteId: query.websiteId } : {}),
    ...(query.moduleKey ? { moduleKey: query.moduleKey } : {}),
    ...(query.campaignId ? { campaignId: query.campaignId } : {}),
    ...(query.source ? { source: query.source } : {}),
    ...(query.q ? { OR: [{ keyword: { contains: query.q } }, { selectedTitle: { contains: query.q } }, { seoTitle: { contains: query.q } }] } : {}),
    ...(from && !Number.isNaN(from.getTime()) ? { createdAt: { gte: from } } : {}),
    ...(to && !Number.isNaN(to.getTime()) ? { createdAt: { ...(from ? { gte: from } : {}), lte: to } } : {}),
  };
}

export interface TaskListRow {
  id: string;
  keyword: string;
  moduleKey: string;
  websiteId: string;
  websiteName: string;
  language: string;
  status: string;
  group: StatusGroup;
  stage: string | null;
  percent: number;
  message: string | null;
  nextAction: string | null;
  pausedFor: string | null;
  seoScore: number | null;
  rankMathScore: number | null;
  wpEditUrl: string | null;
  wpPostId: number | null;
  categoryName: string | null;
  secondaryKeywords: string[];
  exampleTitle: string | null;
  selectedTitle: string | null;
  legacy: boolean;
  source: string;
  createdAt: string;
  updatedAt: string;
  job: { status: string; owner: string | null; runAt: string; attempts: number; error: string | null; queue: string } | null;
  chatgpt: { status: string; tab: string | null; runAt: string; errorCode: string | null } | null;
  reviewReasons: string[];
}

export async function listTasks(query: TaskListQuery): Promise<{ rows: TaskListRow[]; total: number; counts: Record<string, number> }> {
  const where = taskWhere(query);
  const orderBy: Prisma.ArticleTaskOrderByWithRelationInput =
    query.sort === 'created'
      ? { createdAt: query.dir }
      : query.sort === 'keyword'
        ? { keyword: query.dir }
        : query.sort === 'status'
          ? { status: query.dir }
          : query.sort === 'seo'
            ? { seoScore: query.dir }
            : { updatedAt: query.dir };
  const [tasks, total, grouped] = await Promise.all([
    db.articleTask.findMany({
      where,
      orderBy,
      take: query.limit,
      skip: query.offset,
      select: {
        id: true,
        keyword: true,
        moduleKey: true,
        websiteId: true,
        language: true,
        status: true,
        stage: true,
        percent: true,
        message: true,
        nextAction: true,
        pausedFor: true,
        seoScore: true,
        rankMathScore: true,
        wpEditUrl: true,
        wpPostId: true,
        categoryName: true,
        secondaryKeywords: true,
        exampleTitle: true,
        selectedTitle: true,
        legacy: true,
        source: true,
        createdAt: true,
        updatedAt: true,
        reviewReasons: true,
        website: { select: { name: true } },
      },
    }),
    db.articleTask.count({ where }),
    db.articleTask.groupBy({ by: ['status'], _count: { _all: true }, where: { ...taskWhere({ ...query, group: 'all' }) } }),
  ]);
  const ids = tasks.map((t) => t.id);
  const jobs = ids.length
    ? await db.queueJob.findMany({
        where: { taskId: { in: ids }, status: { in: ['WAITING', 'ACTIVE'] } },
        select: { taskId: true, queue: true, status: true, lockedBy: true, claimedByTab: true, runAt: true, attempts: true, error: true, errorCode: true },
      })
    : [];
  const counts: Record<string, number> = { all: 0, queued: 0, running: 0, review: 0, paused: 0, draft: 0, failed: 0, cancelled: 0 };
  for (const g of grouped) {
    counts[statusGroup(g.status)] += g._count._all;
    counts.all += g._count._all;
  }
  const rows: TaskListRow[] = tasks.map((t) => {
    const article = jobs.find((j) => j.taskId === t.id && j.queue === 'article');
    const chat = jobs.find((j) => j.taskId === t.id && j.queue === 'chatgpt');
    return {
      id: t.id,
      keyword: t.keyword,
      moduleKey: t.moduleKey,
      websiteId: t.websiteId,
      websiteName: t.website.name,
      language: t.language,
      status: t.status,
      group: statusGroup(t.status),
      stage: t.stage,
      percent: t.percent,
      message: t.message,
      nextAction: t.nextAction,
      pausedFor: t.pausedFor,
      seoScore: t.seoScore,
      rankMathScore: t.rankMathScore,
      wpEditUrl: t.wpEditUrl,
      wpPostId: t.wpPostId,
      categoryName: t.categoryName,
      secondaryKeywords: stringArray(t.secondaryKeywords),
      exampleTitle: t.exampleTitle,
      selectedTitle: t.selectedTitle,
      legacy: t.legacy,
      source: t.source,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      reviewReasons: parseJson<string[]>(t.reviewReasons, []),
      job: article ? { status: article.status, owner: article.lockedBy, runAt: article.runAt.toISOString(), attempts: article.attempts, error: article.error, queue: article.queue } : null,
      chatgpt: chat ? { status: chat.status, tab: chat.claimedByTab, runAt: chat.runAt.toISOString(), errorCode: chat.errorCode } : null,
    };
  });
  return { rows, total, counts };
}
