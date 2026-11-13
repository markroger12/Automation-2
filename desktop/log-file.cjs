'use strict';
/**
 * The app's log file (data/logs/desktop.log). Owner report 2026-11-13 (“Restart to update”: “A JavaScript error occurred
 * in the main process … ERR_STREAM_WRITE_AFTER_END: write after end”): the app closed its log just before the
 * update was installed, and the updater still logged a line. A line that comes after the log is closed is now added
 * to the file directly, and a log that cannot be written (a full disk) never stops the app.
 */
const fs = require('node:fs');

/** @param {string} file */
function createLogFile(file) {
  let stream = fs.createWriteStream(file, { flags: 'a' });
  // Without a listener, a failed write would be an uncaught error in the main process.
  stream.on('error', () => {
    stream = null;
  });
  const open = () => Boolean(stream) && !stream.writableEnded && !stream.destroyed;
  return {
    /** @param {string} text  one or more whole lines, each ending with a newline */
    write(text) {
      if (open()) {
        stream.write(text);
        return;
      }
      try {
        fs.appendFileSync(file, text);
      } catch {
        /* the log is not writable: the app goes on */
      }
    },
    /** Closes the file; later lines are still added (write). */
    end() {
      if (open()) stream.end();
    },
  };
}

module.exports = { createLogFile };
