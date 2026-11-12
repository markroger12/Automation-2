import { describe, expect, it } from 'vitest';
import { setupSteps, type SetupFacts } from '@/lib/setup';

const fresh: SetupFacts = {
  desktop: true,
  chatgpt: { state: 'never', tabs: 0 },
  websites: [],
  articles: { finished: 0, latest: null },
  settingsSaved: false,
  searchConsole: { requested: false, waitingForSignIn: false },
  assistant: false,
  dismissed: false,
};

/** Owner request 2026-11-12: a first-run checklist from the app's real state. */
describe('setup checklist', () => {
  it('starts with the three required steps to do, and opens the app tabs in the desktop app', () => {
    const s = setupSteps(fresh);
    expect(s).toMatchObject({ done: 0, total: 3, complete: false });
    expect(s.steps.filter((x) => !x.optional).map((x) => x.key)).toEqual(['chatgpt', 'website', 'article']);
    expect(s.steps.find((x) => x.key === 'chatgpt')!.action).toEqual({ label: 'Open the ChatGPT tab', tab: 'chatgpt' });
    expect(s.steps.find((x) => x.key === 'search-console')!.action).toMatchObject({ tab: 'search-console' });
    // The npm copy points to Automation Chrome instead.
    expect(setupSteps({ ...fresh, desktop: false }).steps.find((x) => x.key === 'chatgpt')!.action).toMatchObject({ href: '/automation-chrome' });
  });

  it('ticks steps off from what is measured, and says what needs the owner', () => {
    const s = setupSteps({
      ...fresh,
      chatgpt: { state: 'connected', tabs: 2 },
      websites: [{ id: 'w1', name: 'Example Blog', session: 'LOGIN_REQUIRED' }],
      articles: { finished: 0, latest: { id: 't1', keyword: 'first keyword', status: 'WRITING_ARTICLE' } },
      searchConsole: { requested: false, waitingForSignIn: true },
    });
    const by = Object.fromEntries(s.steps.map((x) => [x.key, x]));
    expect(by.chatgpt).toMatchObject({ state: 'done', detail: expect.stringContaining('2 tabs') });
    expect(by.website).toMatchObject({ state: 'attention', action: { href: '/websites/w1' } });
    expect(by.article).toMatchObject({ state: 'running', detail: expect.stringContaining('Writing article'), action: { href: '/articles/t1' } });
    expect(by['search-console'].state).toBe('attention');
    expect(s.done).toBe(1);
  });

  it('is complete once ChatGPT works, a website is there and an article is finished; optional steps do not count', () => {
    const s = setupSteps({ ...fresh, chatgpt: { state: 'connected', tabs: 1 }, websites: [{ id: 'w1', name: 'Blog', session: 'ACTIVE' }], articles: { finished: 3, latest: null } });
    expect(s).toMatchObject({ done: 3, total: 3, complete: true });
    expect(s.steps.filter((x) => x.optional).every((x) => x.state === 'todo')).toBe(true);
  });
});
