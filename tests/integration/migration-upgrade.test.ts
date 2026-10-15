import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';

/**
 * Upgrading keeps data: migrations that rebuild a table (SQLite
 * "RedefineTables": copy, drop, rename) must not cascade-delete child rows.
 * Applies the shipped migrations with the real `prisma migrate deploy` up to
 * just before the latest Website rebuild, adds a website with children,
 * applies the rest, and compares row counts.
 */
const root = path.resolve(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bas-mig-'));

function deploy(prismaDir: string, dbFile: string) {
  const r = spawnSync(process.execPath, [path.join(root, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy', '--schema', path.join(prismaDir, 'schema.prisma')], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`migrate deploy failed: ${r.stderr || r.stdout}`);
}

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('database upgrade', () => {
  it('a Website table rebuild keeps categories, workflows, keywords, link targets and tasks', async () => {
    const all = fs.readdirSync(path.join(root, 'prisma', 'migrations'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    const rebuilds = all.filter((m) => /CREATE TABLE "new_Website"/.test(fs.readFileSync(path.join(root, 'prisma', 'migrations', m, 'migration.sql'), 'utf8')));
    expect(rebuilds.length).toBeGreaterThan(0);
    const target = rebuilds[rebuilds.length - 1];
    const before = all.slice(0, all.indexOf(target));
    const prismaDir = path.join(tmp, 'prisma');
    fs.mkdirSync(path.join(prismaDir, 'migrations'), { recursive: true });
    fs.copyFileSync(path.join(root, 'prisma', 'schema.prisma'), path.join(prismaDir, 'schema.prisma'));
    fs.copyFileSync(path.join(root, 'prisma', 'migrations', 'migration_lock.toml'), path.join(prismaDir, 'migrations', 'migration_lock.toml'));
    const copy = (m: string) => fs.cpSync(path.join(root, 'prisma', 'migrations', m), path.join(prismaDir, 'migrations', m), { recursive: true });
    before.forEach(copy);
    const dbFile = path.join(tmp, 'app.db').split(path.sep).join('/');
    deploy(prismaDir, dbFile);

    const db = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
    const run = (sql: string) => db.$executeRawUnsafe(sql);
    await run(`INSERT INTO "Website" (id, name, slug, publicUrl, adminUrl, language, targetCountry, timezone, createdAt, updatedAt) VALUES ('w1', 'Site', 'site', 'https://s.example', 'https://s.example/wp-admin/', 'en', 'United States', 'UTC', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
    await run(`INSERT INTO "Category" (id, websiteId, externalId, name, syncedAt) VALUES ('c1', 'w1', 5, 'News', CURRENT_TIMESTAMP)`);
    await run(`INSERT INTO "LinkTarget" (id, websiteId, wpPostId, url, title, createdAt, updatedAt) VALUES ('l1', 'w1', 9, 'https://s.example/p/', 'P', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
    await run(`INSERT INTO "Workflow" (id, websiteId, name, createdAt, updatedAt) VALUES ('wf1', 'w1', 'wf', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
    await run(`INSERT INTO "WorkflowKeyword" (id, workflowId, keyword, normalizedKeyword, position, createdAt, updatedAt) VALUES ('k1', 'wf1', 'kw', 'kw', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
    await run(`INSERT INTO "ArticleTask" (id, moduleKey, websiteId, keyword, normalizedKeyword, language, targetCountry, idempotencyKey, createdAt, updatedAt) VALUES ('t1', 'tigram-writer', 'w1', 'kw', 'kw', 'en', 'United States', 'mig-test-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
    const count = async () => Object.fromEntries(await Promise.all(['Website', 'Category', 'LinkTarget', 'Workflow', 'WorkflowKeyword', 'ArticleTask'].map(async (t) => [t, Number((await db.$queryRawUnsafe<{ c: bigint }[]>(`SELECT COUNT(*) AS c FROM "${t}"`))[0].c)])));
    const counts = await count();
    expect(counts).toEqual({ Website: 1, Category: 1, LinkTarget: 1, Workflow: 1, WorkflowKeyword: 1, ArticleTask: 1 });
    await db.$disconnect();

    all.slice(all.indexOf(target)).forEach(copy);
    deploy(prismaDir, dbFile);
    const after = new PrismaClient({ datasources: { db: { url: `file:${dbFile}` } } });
    const db2 = after;
    const counts2 = Object.fromEntries(await Promise.all(Object.keys(counts).map(async (t) => [t, Number((await db2.$queryRawUnsafe<{ c: bigint }[]>(`SELECT COUNT(*) AS c FROM "${t}"`))[0].c)])));
    expect(counts2).toEqual(counts);
    expect(await db2.$queryRawUnsafe<unknown[]>('PRAGMA foreign_key_check')).toEqual([]);
    const site = (await db2.$queryRawUnsafe<{ name: string; routingRules: string }[]>(`SELECT name, routingRules FROM "Website" WHERE id = 'w1'`))[0];
    expect(site).toEqual({ name: 'Site', routingRules: '[]' });
    await db2.$disconnect();
  }, 120_000);
});
