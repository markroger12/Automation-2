import type { PrismaClient } from '@prisma/client';
import { seedSettings } from './settings';
import { runDataMigrations } from './data-migrations';

type Seeder = (client: PrismaClient) => Promise<string[]>;

/** Additional seeders registered by later milestones (prompts, etc.). */
const seeders: Seeder[] = [];

export function registerSeeder(seeder: Seeder) {
  seeders.push(seeder);
}

export async function seedAll(client: PrismaClient): Promise<string[]> {
  const report: string[] = [];
  report.push((await seedSettings(client)) ? 'Settings: defaults created ✓' : 'Settings: existing values kept ✓');
  const { seedPrompts } = await import('./prompts/seed');
  report.push(...(await seedPrompts(client)));
  for (const seeder of seeders) report.push(...(await seeder(client)));
  report.push(...(await runDataMigrations(client)));
  return report;
}
