import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal logger: prints "<time> LEVEL message {meta}" to stdout/stderr, optionally appends
 * the same line to a log file, and keeps the last `keep` lines in memory for the admin panel.
 */
export function createLogger({ file = '', silent = false, keep = 1000 } = {}) {
  if (file) fs.mkdirSync(path.dirname(file), { recursive: true });
  const buffer = [];

  const write = (level, message, meta) => {
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${meta ? ' ' + JSON.stringify(meta) : ''}`;
    if (!silent) (level === 'error' ? console.error : console.log)(line);
    if (file) fs.appendFileSync(file, line + '\n');
    buffer.push(line);
    if (buffer.length > keep) buffer.shift();
  };

  return {
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
    /** Last `limit` log lines, oldest first. */
    recent: (limit = 200) => buffer.slice(-limit),
  };
}
