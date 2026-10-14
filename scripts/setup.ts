/**
 * npm run setup — idempotent first-time and upgrade setup.
 *
 *  1. checks the Node.js version
 *  2. creates data/ folders
 *  3. creates .env from .env.example ONLY if .env does not exist
 *  4. backs up an existing database, then applies migrations (never resets)
 *  5. seeds missing settings and prompts (never overwrites owner edits)
 *  6. runs data migrations (e.g. retired Celebrity Writer 2.0 handling)
 *  7. checks for an installed Chrome/Edge browser
 *  8. prints next steps
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureDataDirs, projectRoot, dataPaths } from '../src/lib/paths';
import { loadEnv } from '../src/lib/env';
import { runMigrations } from './migrate';
import { runSeed } from './seed';
import { detectBrowsers } from '../src/lib/browsers';

const MIN_NODE_MAJOR = 26;

function step(message: string) {
  console.log(`\n▸ ${message}`);
}

async function main() {
  console.log('Blog Automation Studio 3.0 — setup');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) {
    console.error(`✖ Node.js ${MIN_NODE_MAJOR}+ is required (found ${process.versions.node}). Install the latest Node.js from https://nodejs.org and run setup again.`);
    process.exit(1);
  }
  console.log(`  Node.js ${process.versions.node} ✓`);

  step('Creating data folders');
  ensureDataDirs();
  console.log(`  ${path.relative(projectRoot(), path.dirname(dataPaths.db())) || 'data'}/ ✓`);

  step('Checking .env');
  const envFile = path.join(projectRoot(), '.env');
  if (fs.existsSync(envFile)) {
    console.log('  .env already exists — left untouched ✓');
  } else {
    const example = fs.readFileSync(path.join(projectRoot(), '.env.example'), 'utf8');
    fs.writeFileSync(envFile, example, { flag: 'wx' });
    console.log('  Created .env from .env.example ✓');
  }
  loadEnv();

  step('Applying database migrations (with backup, never resets data)');
  await runMigrations();

  step('Seeding missing settings and prompts');
  await runSeed();

  step('Checking installed browsers');
  const browsers = detectBrowsers();
  if (browsers.length === 0) {
    console.warn('  ⚠ No Google Chrome or Microsoft Edge found. Install Google Chrome (https://www.google.com/chrome/) — it is required for ChatGPT and WordPress automation.');
  } else {
    for (const b of browsers) console.log(`  ${b.name}: ${b.path} ✓`);
  }

  console.log(`
✔ Setup complete. Next steps:
  1. npm run dev:all            (starts the dashboard and the single worker)
  2. Open http://localhost:3000
  3. Websites → Add website → Log in (visible window) → Sync categories
  4. Automation Chrome → follow the 5-step wizard to load and pair the extension
  5. Single Article → Generate Article
`);
}

main().catch((error) => {
  console.error('\n✖ Setup failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
