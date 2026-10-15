import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { createTask, createWebsite } from '../helpers/fixtures';

/** The per-article report the owner downloads and shares for support. */
let client: PrismaClient;
let report: typeof import('@/lib/tasks/report');

beforeAll(async () => {
  ({ client } = await setupTestDb());
  report = await import('@/lib/tasks/report');
});

describe('article report', () => {
  it('contains the task, every stage with its prompt and output, every ChatGPT exchange and the logs, with secrets redacted', async () => {
    const site = await createWebsite(client);
    const task = await createTask(client, site.id, { keyword: 'Gloria Krass' });
    await client.articleTask.update({ where: { id: task.id }, data: { reviewReasons: JSON.stringify(['Rank Math score could not be read']), wpPostId: 7479, slug: 'gloria-krass' } });
    await client.articleStage.create({ data: { taskId: task.id, key: 'FAQS', position: 5, label: 'FAQs', kind: 'chatgpt', status: 'FAILED', attempts: 3, prompt: 'Write 5 FAQs', output: 'QUESTION: Wer? ANSWER: Sie.', error: 'Only 0 of 5 FAQs could be parsed.' } });
    await client.chatGPTResponse.create({ data: { taskId: task.id, stageKey: 'FAQS', attempt: 1, operationId: `${task.id}:FAQS:a1`, promptHash: 'h', renderedPrompt: 'Write 5 FAQs', resultText: 'QUESTION: Wer? ANSWER: Sie.', status: 'REJECTED', recovered: true } });
    await client.log.create({ data: { taskId: task.id, level: 'warn', category: 'chatgpt', stage: 'FAQS', message: 'retry with Authorization: Bearer abcdefghijklmnop' } });

    const r = await report.articleReport(task.id);
    expect(r.kind).toBe('blog-automation-studio.article-report');
    expect(r.task.keyword).toBe('Gloria Krass');
    expect(r.task.reviewReasons).toEqual(['Rank Math score could not be read']);
    expect(r.task.wordpress.postId).toBe(7479);
    const faqs = r.stages.find((s) => s.stageKey === 'FAQS')!;
    expect(faqs).toMatchObject({ status: 'FAILED', attempts: 3, prompt: 'Write 5 FAQs', output: 'QUESTION: Wer? ANSWER: Sie.', error: 'Only 0 of 5 FAQs could be parsed.' });
    expect(r.chatgpt).toEqual([expect.objectContaining({ stageKey: 'FAQS', status: 'REJECTED', recovered: true, prompt: 'Write 5 FAQs', answer: 'QUESTION: Wer? ANSWER: Sie.' })]);
    expect(r.logs[0].message).toMatch(/^retry with Authorization: .*\[REDACTED\]/);
    expect(JSON.stringify(r)).not.toContain('abcdefghijklmnop');
    expect(report.articleReportFilename({ id: task.id, slug: 'gloria-krass', keyword: 'Gloria Krass' })).toBe('article-report-gloria-krass.json');
    expect(report.articleReportFilename({ id: task.id, slug: null, keyword: 'Größe & Gewicht' })).toBe('article-report-grosse-gewicht.json');
  });
});
