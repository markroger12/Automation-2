/**
 * Where this copy of the tool runs. Inside the desktop app (desktop/main.cjs sets BAS_DESKTOP=1) the texts name the
 * app and its tabs, never npm commands (owner request 2026-11-12: it should feel like a finished program).
 */
export const inDesktopApp = (): boolean => process.env.BAS_DESKTOP === '1';

/** What to do when the worker is not running, in this copy's words. */
export const startWorkerHint = (): string =>
  inDesktopApp() ? 'The app starts it again by itself. If this stays, quit the app from its tray icon and open it again.' : 'Start it with npm run start:all (or npm run dev:all while developing).';

/** What to do when the database cannot be opened, in this copy's words. */
export const databaseHint = (): string => (inDesktopApp() ? 'Quit the app from its tray icon and open it again; it prepares the database at start.' : 'Run npm run setup to create or migrate data/app.db.');
