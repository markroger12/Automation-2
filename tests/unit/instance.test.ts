import { describe, expect, it } from 'vitest';
import { dataFolderId, INSTANCE_APP, instanceInfo } from '@/lib/instance';

describe('owner request (desktop app): which tool and data folder answer on a port', () => {
  it('the same folder gives the same id (a trailing slash too); another folder another id; the path is never shown', () => {
    expect(dataFolderId('/data/a')).toBe(dataFolderId('/data/a/'));
    expect(dataFolderId('/data/a')).not.toBe(dataFolderId('/data/b'));
    expect(dataFolderId('/data/a')).toMatch(/^[0-9a-f]{16}$/);
    const info = instanceInfo();
    expect(info.app).toBe(INSTANCE_APP);
    expect(JSON.stringify(info)).not.toContain('/');
  });
});
