/**
 * Report of the owner-authorized 2-hour throughput benchmark (spec §22), from
 * stored evidence only. Run AFTER the live test, with the time it started:
 *   npm run benchmark:report -- 2026-10-15T09:00:00Z
 * (without a time: the two hours ending now). Prints Markdown and saves it to
 * data/reports/. It starts no work and never contacts ChatGPT or WordPress.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../src/lib/env';

loadEnv();
const arg = process.argv[2];
const from = arg ? new Date(arg) : new Date(Date.now() - 120 * 60_000);
if (Number.isNaN(from.getTime())) {
  console.error('Give the start time as an ISO date, e.g. 2026-10-15T09:00:00Z');
  process.exit(2);
}
const { benchmarkReport, benchmarkMarkdown } = await import('../src/lib/analytics/benchmark');
const { dataPaths } = await import('../src/lib/paths');
const { db } = await import('../src/lib/db');
const report = await benchmarkReport(from);
const md = benchmarkMarkdown(report);
const dir = dataPaths.reports();
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `benchmark-${report.from.replace(/[:.]/g, '-')}.md`);
fs.writeFileSync(file, md);
console.log(md);
console.log(`Saved to ${file}`);
await db.$disconnect();
process.exit(report.benchmark.claim === 'PASS' ? 0 : 1);
