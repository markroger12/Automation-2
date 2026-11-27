'use strict';
// Loaded first (`--require`) in the dashboard server the desktop app starts. When the app is gone (its channel to the
// server closes, also after a crash), the server stops too, so no copy is left running on its port. The worker stops
// the same way by itself (src/worker/runtime.ts).
if (process.send) process.on('disconnect', () => process.exit(0));
