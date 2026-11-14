/**
 * Caches that AI tools fill but share with other programs: packages npx and uvx fetch to start
 * MCP servers, the browsers browser tools download, models downloaded from Hugging Face.
 *
 * They belong to no single app, so they are measured as a whole, only when the user asks:
 * never listed file by file, never attributed to an app, never selectable and never cleaned up
 * from Artifact Atlas. Each is cleared with its own tool. Read with lstat; links are not
 * followed; a hardlinked file counts once.
 */
import fs from 'node:fs';
import path from 'node:path';

export const SHARED_CACHES = Object.freeze([
  {
    id: 'npx',
    name: 'npx packages',
    usedBy: 'MCP servers and tools started with npx',
    clearWith: 'npm cache clean --force',
    unix: ['.npm/_npx'],
    windows: ['AppData/Local/npm-cache/_npx']
  },
  {
    id: 'uv',
    name: 'uv cache',
    usedBy: 'MCP servers and tools started with uvx',
    clearWith: 'uv cache clean',
    unix: ['.cache/uv', 'Library/Caches/uv'],
    windows: ['AppData/Local/uv/cache']
  },
  {
    id: 'playwright',
    name: 'Playwright browsers',
    usedBy: 'browser tools that agents drive',
    clearWith: 'npx playwright uninstall --all',
    unix: ['Library/Caches/ms-playwright', '.cache/ms-playwright'],
    windows: ['AppData/Local/ms-playwright']
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer browsers',
    usedBy: 'browser tools that agents drive',
    clearWith: null,
    unix: ['.cache/puppeteer'],
    windows: ['.cache/puppeteer']
  },
  {
    id: 'huggingface',
    name: 'Hugging Face models',
    usedBy: 'models downloaded by local AI tools',
    clearWith: 'hf cache delete',
    unix: ['.cache/huggingface'],
    windows: ['.cache/huggingface']
  }
]);

/** The cache folders that exist for this home: real folders, not links, not protected. */
export function sharedCacheFolders(platformServices) {
  const out = [];
  for (const cache of SHARED_CACHES) {
    const rels = platformServices.isWindowsLayout ? cache.windows : cache.unix;
    for (const rel of rels) {
      const full = path.join(platformServices.homeDir, ...rel.split('/'));
      const stat = fs.lstatSync(full, { throwIfNoEntry: false });
      if (!stat || !stat.isDirectory() || platformServices.isProtectedSystemPath(full)) continue;
      out.push({ ...cache, key: `${cache.id}:${rel}`, path: full });
    }
  }
  return out;
}

/**
 * Measures each cache folder: bytes, files, newest change. Pauses every 1,000 entries so the
 * app stays responsive, stops at maxEntries per folder (then says so) and when cancelled.
 */
export async function measureSharedCaches(platformServices, { signal = null, maxEntries = 300000 } = {}) {
  const seen = new Set();
  const results = [];
  for (const cache of sharedCacheFolders(platformServices)) {
    let bytes = 0;
    let files = 0;
    let newest = 0;
    let entries = 0;
    let truncated = false;
    const stack = [cache.path];
    while (stack.length) {
      if (signal?.aborted) return { cancelled: true, caches: results };
      const dir = stack.pop();
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (++entries > maxEntries) {
          truncated = true;
          break;
        }
        if (entries % 1000 === 0) await new Promise((resolve) => setImmediate(resolve));
        const full = path.join(dir, name);
        const st = fs.lstatSync(full, { throwIfNoEntry: false, bigint: false });
        if (!st || st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          stack.push(full);
        } else if (st.isFile()) {
          files += 1;
          const key = `${st.dev}:${st.ino}`;
          if (!seen.has(key)) {
            seen.add(key);
            bytes += st.blocks ? st.blocks * 512 : st.size;
          }
          if (st.mtimeMs > newest) newest = st.mtimeMs;
        }
      }
      if (truncated) break;
    }
    results.push({
      id: cache.key,
      name: cache.name,
      usedBy: cache.usedBy,
      clearWith: cache.clearWith,
      path: cache.path,
      bytes,
      files,
      newestChange: newest ? new Date(newest).toISOString() : null,
      truncated
    });
  }
  return { cancelled: false, caches: results.sort((a, b) => b.bytes - a.bytes) };
}
