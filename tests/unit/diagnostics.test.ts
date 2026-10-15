import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';

/** The downloadable diagnostic bundle carries state for support, never secrets. */
let client: PrismaClient;

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
});

describe('diagnostic bundle', () => {
  it('includes worker/queue/rate-limit/snapshot/stage/session state and strips cookies, keys, tokens and passwords', async () => {
    const { createConnectionKey } = await import('@/lib/agent/keys');
    const { key } = await createConnectionKey();
    process.env.SERPER_API_KEY = 'serper-secret-key-123456';
    const { log } = await import('@/lib/log');
    await log({ level: 'error', category: 'wordpress', message: 'login failed password=hunter2 Cookie: wordpress_logged_in_abc123=SESSIONVALUE; token=abcdef123456 Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl' });
    await client.queueJob.create({
      data: {
        queue: 'chatgpt',
        kind: 'chatgpt.prompt',
        idempotencyKey: 'diag-snapshot-1',
        status: 'FAILED',
        error: 'Composer not found',
        errorCode: 'DOM_MISSING',
        progress: JSON.stringify({ failureSnapshot: { url: 'https://chatgpt.com/c/abc?token=tok_SECRET99', variant: 'v2', composer: 'missing', sendButton: 'absent', cookie: 'oai-session=SECRETCOOKIE' } }),
      },
    });
    const { recordRateLimit } = await import('@/lib/chatgpt/rate');
    await recordRateLimit({ retryAfterMs: 60_000, reason: 'HTTP 429 from ChatGPT' });

    const { collectDiagnostics } = await import('@/lib/diagnostics');
    const d = await collectDiagnostics();
    const json = JSON.stringify(d);

    // State is there…
    expect(d.chatgptRate.last429At).toBeTruthy();
    expect(d.chatgptRate.recent429Count).toBe(1);
    expect(d.chatgptRate.backoffUntil).toBeTruthy();
    expect(d.failureSnapshots).toHaveLength(1);
    expect(d.failureSnapshots[0].snapshot).toMatchObject({ variant: 'v2', composer: 'missing', sendButton: 'absent' });
    expect(d.services.searchApiConfigured).toBe(true);
    expect(d.logs.recentErrors[0].message).toMatch(/login failed/);
    expect(Array.isArray(d.sessions)).toBe(true);
    expect(Array.isArray(d.failedStages)).toBe(true);

    // …secrets are not.
    for (const secret of [key, 'hunter2', 'SESSIONVALUE', 'abcdef123456', 'eyJhbGciOiJIUzI1NiJ9', 'tok_SECRET99', 'SECRETCOOKIE', 'serper-secret-key-123456']) expect(json, secret).not.toContain(secret);
    delete process.env.SERPER_API_KEY;
  });
});
