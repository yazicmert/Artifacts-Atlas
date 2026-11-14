import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ArtifactType } from '../models/entities.js';

/**
 * A text the user can copy and share to help support more applications, made only when they
 * ask. Nothing is sent anywhere. It holds:
 *   - where the largest unclassified files are (folders relative to the home folder, sizes)
 *   - the shape of Cursor's and Codex's records: field names and value types only. Field
 *     names that are IDs or paths become placeholders; no value, prompt or reply is included
 *     (AGENTS.md rule 6). Cursor's database is opened read-only.
 */

const MAX_DEPTH = 5;
const MAX_KEYS = 40;
const FILE_NAME = /\.(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|md|mdx|txt|json|jsonl|yml|yaml|toml|xml|html|css|scss|csv|tsv|xlsx|xls|docx|doc|pptx|pdf|png|jpe?g|gif|svg|webp|zip|lock|log|sql|ipynb|env)$/i;
const ID_KEY = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|\d{6,})$/i;

/** A field name as shown: IDs, paths and long or odd names become placeholders. */
export function normalizeKey(key) {
  const k = String(key);
  if (ID_KEY.test(k)) return '<id>';
  if (/[\\/]/.test(k) || /^[A-Za-z]:/.test(k) || k.startsWith('file:')) return '<path>';
  if (/@/.test(k)) return '<name>';
  // A field name with a file ending is a file name, not a field
  if (FILE_NAME.test(k)) return '<file>';
  // "composerData:3f2a…" keeps its prefix and hides the id
  const named = k.replace(/([:._-])(?:[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9a-f]{16,}|\d{6,})/gi, '$1<id>');
  if (named.length > 48 || /\s/.test(named)) return '<text>';
  return named;
}

/** The shape of a JSON value: field names and value types, never the values. */
export function shapeOf(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (depth >= MAX_DEPTH) return '[…]';
    return [mergeShapes(value.slice(0, 5).map((v) => shapeOf(v, depth + 1)))];
  }
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return '{…}';
    const keys = Object.keys(value);
    // An object with many keys is a map (keyed by names, files or ids): one placeholder
    if (keys.length > 12) {
      return { '<key>': mergeShapes(keys.slice(0, 10).map((k) => shapeOf(value[k], depth + 1))), '…': `${keys.length} entries` };
    }
    const out = {};
    for (const key of Object.keys(value).slice(0, MAX_KEYS)) {
      const name = normalizeKey(key);
      out[name] = out[name] ? mergeShapes([out[name], shapeOf(value[key], depth + 1)]) : shapeOf(value[key], depth + 1);
    }
    if (Object.keys(value).length > MAX_KEYS) out['…'] = `${Object.keys(value).length - MAX_KEYS} more`;
    return out;
  }
  return typeof value;
}

export function mergeShapes(shapes) {
  const objects = shapes.filter((s) => s && typeof s === 'object' && !Array.isArray(s));
  const others = new Set(shapes.filter((s) => !(s && typeof s === 'object' && !Array.isArray(s))).map((s) => JSON.stringify(s)));
  if (objects.length > 0) {
    const merged = {};
    for (const o of objects) {
      for (const [k, v] of Object.entries(o)) merged[k] = k in merged ? mergeShapes([merged[k], v]) : v;
    }
    if (others.size === 0) return merged;
    return { '<one of>': [...[...others].map((s) => JSON.parse(s)), merged] };
  }
  const list = [...others].map((s) => JSON.parse(s));
  return list.length === 1 ? list[0] : list.join(' | ');
}

function newestFiles(dir, test, { depth = 5, limit = 3 } = {}) {
  const found = [];
  const walk = (d, left) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory() && left > 0) walk(p, left - 1);
      else if (e.isFile() && test(e.name)) {
        const st = fs.lstatSync(p, { throwIfNoEntry: false });
        if (st) found.push({ path: p, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(dir, depth);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit).map((f) => f.path);
}

/** Codex: JSONL records, grouped by their record type. */
export function codexRecordShapes(homeDir) {
  const files = newestFiles(path.join(homeDir, '.codex', 'sessions'), (n) => n.endsWith('.jsonl'));
  if (files.length === 0) return null;
  const byType = new Map();
  for (const file of files) {
    let lines;
    try {
      // The first 512 KB is enough for the shape; a record cut off at the end is skipped
      const fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(512 * 1024);
      const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
      fs.closeSync(fd);
      lines = buffer.subarray(0, n).toString('utf8').split('\n').slice(0, 300);
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const t = record && typeof record.type === 'string' && /^[a-z_]{1,40}$/i.test(record.type) ? record.type : '<untyped>';
      const shape = shapeOf(record);
      byType.set(t, byType.has(t) ? mergeShapes([byType.get(t), shape]) : shape);
    }
  }
  return { files: files.length, recordTypes: Object.fromEntries(byType) };
}

/** Cursor: its state databases, opened read-only. Key patterns and the shape of JSON values. */
export function cursorRecordShapes(homeDir, { platform = process.platform } = {}) {
  const base = platform === 'win32' ? path.join(homeDir, 'AppData', 'Roaming', 'Cursor', 'User') : path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'User');
  const dbs = [path.join(base, 'globalStorage', 'state.vscdb'), ...newestFiles(path.join(base, 'workspaceStorage'), (n) => n === 'state.vscdb', { depth: 1, limit: 1 })];
  const out = {};
  for (const dbPath of dbs) {
    const st = fs.lstatSync(dbPath, { throwIfNoEntry: false });
    if (!st || !st.isFile()) continue;
    let db;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
      const tableShapes = {};
      for (const table of tables) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) continue;
        const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        if (!cols.includes('key') || !cols.includes('value')) {
          tableShapes[table] = { columns: cols };
          continue;
        }
        // Keys first; a value is read only for the few samples of each pattern
        const patterns = new Map();
        const valueOf = db.prepare(`SELECT value FROM ${table} WHERE key = ? LIMIT 1`);
        for (const row of db.prepare(`SELECT key FROM ${table} LIMIT 20000`).iterate()) {
          const pattern = normalizeKey(row.key);
          const entry = patterns.get(pattern) || { count: 0, shape: null, samples: 0 };
          entry.count += 1;
          if (entry.samples < 3) {
            const value = valueOf.get(row.key)?.value;
            const text = typeof value === 'string' ? value : Buffer.isBuffer(value) || value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : null;
            if (text && /^[[{]/.test(text.trim())) {
              try {
                const shape = shapeOf(JSON.parse(text));
                entry.shape = entry.shape ? mergeShapes([entry.shape, shape]) : shape;
                entry.samples += 1;
              } catch {
                // Not JSON: only counted
              }
            }
          }
          patterns.set(pattern, entry);
        }
        tableShapes[table] = Object.fromEntries(
          [...patterns].sort((a, b) => b[1].count - a[1].count).slice(0, 60).map(([k, v]) => [k, { count: v.count, ...(v.shape ? { shape: v.shape } : {}) }])
        );
      }
      out[path.relative(base, dbPath).split(path.sep).join('/').replace(/^workspaceStorage\/[^/]+/, 'workspaceStorage/<id>')] = tableShapes;
    } catch (err) {
      out[path.basename(dbPath)] = { error: 'could not be opened read-only' };
    } finally {
      try {
        db?.close();
      } catch {
        // Already closed
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Cursor's agent transcripts (~/.cursor/projects/<project>/agent-transcripts): how they are laid
 * out, never what they say. File names become patterns (IDs become placeholders) and only JSON
 * lines are described, by field names and types; plain text is counted, not read.
 */
export function cursorTranscriptLayout(homeDir) {
  const root = path.join(homeDir, '.cursor', 'projects');
  const files = [];
  const walk = (d, left, inTranscripts) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory() && left > 0) walk(p, left - 1, inTranscripts || e.name === 'agent-transcripts');
      else if (e.isFile() && inTranscripts) files.push(p);
    }
  };
  walk(root, 4, false);
  if (files.length === 0) return null;
  const patterns = new Map();
  for (const f of files) {
    const parts = path.relative(root, f).split(path.sep);
    const rel = parts.map((part, i) => {
      if (i === 0) return '<project>';
      // A file keeps its ending (.txt, .jsonl), the useful part; its name becomes a pattern
      const ext = i === parts.length - 1 ? path.extname(part) : '';
      return /^\.[a-z0-9]{1,8}$/i.test(ext) ? `${normalizeKey(part.slice(0, -ext.length))}${ext.toLowerCase()}` : normalizeKey(part);
    });
    const key = rel.join('/');
    patterns.set(key, (patterns.get(key) || 0) + 1);
  }
  const jsonl = newestFiles(root, (n) => n.endsWith('.jsonl') || n.endsWith('.json'), { depth: 4, limit: 2 }).filter((f) => f.includes(`${path.sep}agent-transcripts${path.sep}`));
  const shapes = [];
  for (const file of jsonl) {
    try {
      const fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
      fs.closeSync(fd);
      for (const line of buffer.subarray(0, n).toString('utf8').split('\n').slice(0, 200)) {
        if (!/^\s*[[{]/.test(line)) continue;
        try {
          shapes.push(shapeOf(JSON.parse(line)));
        } catch {
          // Cut off at the end of the sample
        }
      }
    } catch {
      // Unreadable: only counted
    }
  }
  return {
    files: files.length,
    layout: Object.fromEntries([...patterns].sort((a, b) => b[1] - a[1]).slice(0, 20)),
    ...(shapes.length ? { jsonShape: mergeShapes(shapes) } : {})
  };
}

/** Codex's own databases (state_*.sqlite) and archive: table and column names, file counts. */
export function codexStoreLayout(homeDir) {
  const codexHome = path.join(homeDir, '.codex');
  let names = [];
  try {
    names = fs.readdirSync(codexHome);
  } catch {
    return null;
  }
  const out = {};
  for (const name of names.filter((n) => /^state(_\d+)?\.sqlite$/.test(n))) {
    let db;
    try {
      db = new DatabaseSync(path.join(codexHome, name), { readOnly: true });
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
      out[normalizeKey(name)] = Object.fromEntries(
        tables.filter((t) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(t)).map((t) => [t, db.prepare(`PRAGMA table_info(${t})`).all().map((c) => `${c.name}:${c.type || '?'}`)])
      );
    } catch {
      out[normalizeKey(name)] = { error: 'could not be opened read-only' };
    } finally {
      try {
        db?.close();
      } catch {
        // Already closed
      }
    }
  }
  const archived = newestFiles(path.join(codexHome, 'archived_sessions'), (n) => n.endsWith('.jsonl'), { depth: 5, limit: 100000 }).length;
  if (archived) out.archivedRollouts = archived;
  return Object.keys(out).length ? out : null;
}

/** Where the largest unclassified files are, by folder relative to the home folder. */
export function unclassifiedFolders(state, homeDir, { limit = 20 } = {}) {
  const groups = new Map();
  const exts = new Map();
  for (const a of state?.artifacts || []) {
    if (a.quarantined || a.artifactType !== ArtifactType.UNKNOWN) continue;
    const rel = path.relative(homeDir, path.dirname(a.canonicalPath));
    const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    const parts = inside ? rel.split(path.sep) : [path.dirname(a.canonicalPath)];
    const key = inside ? `~/${parts.slice(0, 5).join('/')}` : parts[0];
    const g = groups.get(key) || { files: 0, bytes: 0 };
    g.files += 1;
    g.bytes += a.sizeBytes || 0;
    groups.set(key, g);
    const ext = (a.extension || '').toLowerCase() || '(none)';
    const e = exts.get(ext) || { files: 0, bytes: 0 };
    e.files += 1;
    e.bytes += a.sizeBytes || 0;
    exts.set(ext, e);
  }
  const top = (m) => [...m].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, limit).map(([k, v]) => ({ name: k, ...v }));
  return { folders: top(groups), extensions: top(exts) };
}

export function buildDiagnostics({ state, homeDir, platform, appVersion }) {
  const fmt = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;
  const unclassified = unclassifiedFolders(state, homeDir);
  const codex = codexRecordShapes(homeDir);
  const cursor = cursorRecordShapes(homeDir, { platform });
  const cursorTranscripts = cursorTranscriptLayout(homeDir);
  const codexStore = codexStoreLayout(homeDir);
  const lines = [
    `Artifact Atlas ${appVersion || ''} diagnostics (${platform})`,
    `Scanned: ${state?.application?.name || 'nothing yet'}`,
    '',
    'Largest unclassified folders:',
    ...(unclassified.folders.length ? unclassified.folders.map((f) => `  ${fmt(f.bytes).padStart(10)}  ${String(f.files).padStart(7)} files  ${f.name}`) : ['  (none in this scan)']),
    '',
    'Largest unclassified file types:',
    ...(unclassified.extensions.length ? unclassified.extensions.map((e) => `  ${fmt(e.bytes).padStart(10)}  ${String(e.files).padStart(7)} files  ${e.name}`) : ['  (none)']),
    '',
    'Codex record shapes (field names and types only):',
    codex ? JSON.stringify(codex, null, 1) : '  (no Codex records found)',
    '',
    'Codex databases and archive (table and column names, counts):',
    codexStore ? JSON.stringify(codexStore, null, 1) : '  (none found)',
    '',
    'Cursor record shapes (field names and types only):',
    cursor ? JSON.stringify(cursor, null, 1) : '  (no Cursor database found)',
    '',
    'Cursor agent transcripts (layout only; text is not read):',
    cursorTranscripts ? JSON.stringify(cursorTranscripts, null, 1) : '  (none found)'
  ];
  return lines.join('\n');
}
