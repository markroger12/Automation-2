import { describe, expect, it } from 'vitest';
import { defaultSettings, effectiveTaskConfig, settingsSchema, siteOverridesSchema, taskOptionsSchema } from '@/lib/settings-schema';

describe('settings schema', () => {
  it('has the specified defaults', () => {
    const s = defaultSettings();
    expect(s.browser.mode).toBe('headless');
    expect(s.browser.navigationTimeoutSec).toBe(60);
    expect(s.browser.generationTimeoutSec).toBe(600);
    expect(s.browser.chatgptUrl).toBe('https://chatgpt.com/');
    expect(s.workflow.taskConcurrency).toBe(3);
    expect(s.workflow.maxTaskConcurrency).toBe(5);
    expect(s.workflow.targetArticlesPerHour).toBe(6);
    expect(s.workflow.highThroughputMode).toBe(true);
    expect(s.workflow.autoSendToWordPress).toBe(true);
    expect(s.workflow.workflowCelebrityWriter).toBe('1.0');
    expect(s.content.maxArticleWordCount).toBe(1300);
    expect(s.content.faqCount).toBe(5);
    expect(s.content.quickBioRows).toBe(12);
    expect(s.seo.reviewThreshold).toBe(70);
    expect(s.seo.rankMathTargetScore).toBe(75);
    expect(s.seo.maxRankMathAttempts).toBe(3);
    expect(s.seo.maxExternalLinks).toBe(5);
    expect(s.seo.enhanceCelebrityImages).toBe(true); // Upscayl when installed (owner's earlier tool)
    expect(s.content.humanizerEnabled).toBe(false); // off by default; switched on per website (owner decision)
    expect(s.advanced.backoffScheduleSec).toEqual([4, 30, 60, 120, 240, 300]);
  });

  it('rejects out-of-range concurrency and retired writer selection', () => {
    expect(settingsSchema.safeParse({ workflow: { taskConcurrency: 9 } }).success).toBe(false);
    expect(settingsSchema.safeParse({ workflow: { workflowCelebrityWriter: '2.0' } }).success).toBe(false);
  });

  it('merges global → site → task options without leaking between levels', () => {
    const global = defaultSettings();
    const site = siteOverridesSchema.parse({ content: { maxArticleWordCount: 1100 }, seo: { articleImages: false } });
    const options = taskOptionsSchema.parse({ faqCount: 4, images: 'on' });
    const cfg = effectiveTaskConfig(global, site, options);
    expect(cfg.maxWords).toBe(1100);
    expect(cfg.faqCount).toBe(4);
    expect(cfg.images).toBe(true);
    const cfg2 = effectiveTaskConfig(global, site, taskOptionsSchema.parse({}));
    expect(cfg2.images).toBe(false);
    expect(cfg2.faqCount).toBe(5);
    expect(cfg2.saveToWordPress).toBe(true);
  });
});
