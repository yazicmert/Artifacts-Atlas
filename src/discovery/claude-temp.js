/**
 * Claude Code's working files in the system temp folder: a folder per user (`claude-<uid>`)
 * holding each session's command output, scratch files and pasted images under the session's
 * ID, and its diagnostic logs (`claude-code-<n>.diag.log`).
 *
 * Read only for the live home (see PlatformServices.isLiveHome): the temp folder belongs to
 * this machine, not to the sample or a folder named with --home. The temp folder is shared
 * with other users and programs, so it is never walked itself: only a folder or file that is
 * named like Claude Code's, is not a link, and belongs to the current user is taken, and
 * each is listed by name only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR_NAME = /^claude(-\d+)?$/;
const LOG_NAME = /^claude-code-\d+\.diag\.log$/;

function ownedByUser(stat) {
  // Windows has no user IDs here; its temp folder is the user's own
  if (typeof process.getuid !== 'function') return true;
  return stat.uid === process.getuid();
}

/** The temp folders Claude Code may use on this machine, existing ones only. */
export function claudeTempBases(env = process.env) {
  const bases = [];
  if (process.platform !== 'win32') bases.push('/tmp');
  bases.push(os.tmpdir());
  if (typeof env.CLAUDE_CODE_TMPDIR === 'string' && path.isAbsolute(env.CLAUDE_CODE_TMPDIR)) bases.push(env.CLAUDE_CODE_TMPDIR);
  const seen = new Set();
  const out = [];
  for (const base of bases) {
    let real;
    try {
      real = fs.realpathSync(base);
    } catch {
      continue;
    }
    if (!seen.has(real)) {
      seen.add(real);
      out.push(real);
    }
  }
  return out;
}

/** Data locations for the Claude Code adapter: [{ role, path }], empty unless the live home. */
export function claudeTempLocations(platformServices) {
  if (!platformServices?.isLiveHome) return [];
  const out = [];
  for (const base of platformServices.tempBases || claudeTempBases(platformServices.env)) {
    let names = [];
    try {
      names = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const name of names) {
      const isDir = DIR_NAME.test(name);
      if (!isDir && !LOG_NAME.test(name)) continue;
      const full = path.join(base, name);
      const stat = fs.lstatSync(full, { throwIfNoEntry: false });
      if (!stat || stat.isSymbolicLink() || !ownedByUser(stat)) continue;
      if (isDir ? stat.isDirectory() : stat.isFile()) {
        out.push({ role: isDir ? 'TEMP' : 'TEMP_LOG', path: full });
      }
    }
  }
  return out;
}
