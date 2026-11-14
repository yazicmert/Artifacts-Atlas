/**
 * Review-first files, grouped so they can be decided a folder at a time instead of one by one.
 *
 * Files are grouped by where they are: the app's data folder (or project) they are in, then up
 * to three folders below it, with session IDs and other IDs replaced by `*`, so the working files
 * of every session fall in one group. Each group says only what can be shown: that the app makes
 * these files again (a temp, cache or log folder), that they are the working files of sessions,
 * or that they are not recognised. Never conversation text; examples are file names.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { computePromptCosts } from './prompt-costs.js';
import { REMADE_FOLDERS } from '../classification/app-folders.js';

export const MAX_REVIEW_GROUPS = 40;
const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|\d{6,}|[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*[0-9a-f]{8,}[A-Za-z0-9_-]*)$/i;
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');

function containingRoot(file, roots) {
  const f = norm(file);
  let best = null;
  for (const r of roots) {
    const n = norm(r);
    if (n && f.startsWith(`${n}/`) && (!best || n.length > norm(best).length)) best = r;
  }
  return best;
}

/** Where a file is grouped: [root, pattern segments], IDs as `*`, at most three folders deep. */
export function reviewGroupKey(filePath, roots, sessionIds = new Set()) {
  const root = containingRoot(filePath, roots) || path.dirname(filePath);
  const rel = norm(filePath).slice(norm(root).length + 1).split('/').slice(0, -1);
  const parts = rel.slice(0, 3).map((seg) => (ID_SEGMENT.test(seg) || sessionIds.has(seg) ? '*' : seg));
  return { root, parts };
}

const REMADE_ROLES = new Set(['CACHES', 'LOGS', 'CLI_CACHE', 'TEMP_LOG']);

function describe(parts, rootRole) {
  const lower = parts.map((p) => p.toLowerCase());
  if (REMADE_ROLES.has(rootRole) || lower.some((p) => REMADE_FOLDERS.has(p))) {
    return { kind: 'remade', what: 'Temporary, cache or log files: the app makes these again when it needs them.' };
  }
  if (rootRole === 'TEMP') {
    return { kind: 'session-work', what: 'Working files of Claude Code sessions: command output, scratch files and pasted images. Needed while a session runs, or to look back at it.' };
  }
  return { kind: 'unrecognised', what: 'Not recognised. Look at the examples before you decide.' };
}

/**
 * The groups, largest first. `kept` is a set of group keys the user chose to keep; those are
 * returned apart. Each group carries its file ids only on the server (`artifactIds`).
 */
export function buildReviewGroups(state, { kept = new Set(), now = Date.now() } = {}) {
  const dataDirs = state.application?.knownDataDirectories || [];
  const roots = [...dataDirs.map((d) => d.path), ...(state.workspaces || []).map((w) => w.canonicalPath)].filter(Boolean);
  const roleOf = new Map(dataDirs.map((d) => [d.path, d.role]));
  const projectRoots = new Set((state.workspaces || []).map((w) => w.canonicalPath).filter(Boolean));
  const sessions = state.sessions || [];
  const sessionIds = new Set(sessions.map((s) => s.externalSessionId).filter(Boolean));
  const costs = computePromptCosts(state, { now });
  const groups = new Map();
  const seen = new Set();
  for (const a of state.artifacts || []) {
    if (a.quarantined || a.cleanupClassification !== 'REVIEW') continue;
    // A log the app keeps as a single file (Claude Code's diag logs) is grouped with its kind
    const asLog = roleOf.get(a.canonicalPath) === 'TEMP_LOG';
    const { root, parts } = asLog ? { root: path.dirname(a.canonicalPath), parts: [] } : reviewGroupKey(a.canonicalPath, roots, sessionIds);
    const key = asLog ? `${norm(root)}/claude-code-*.diag.log` : [norm(root), ...parts].join('/');
    let g = groups.get(key);
    if (!g) {
      g = {
        id: `rg_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
        key,
        root,
        parts,
        ...(asLog
          ? { kind: 'remade', what: 'Diagnostic logs of Claude Code. It writes new ones as it runs.' }
          : describe(parts, roleOf.get(root))),
        count: 0,
        bytes: 0,
        newestChange: null,
        sessions: new Set(),
        inUse: false,
        examples: [],
        kinds: new Set(),
        artifactIds: []
      };
      groups.set(key, g);
    }
    const inode = a.physicalInodeKey || a.canonicalPath;
    g.bytes += seen.has(inode) ? 0 : a.sizeBytes || 0;
    seen.add(inode);
    g.count += 1;
    g.kinds.add(a.artifactType);
    g.artifactIds.push(a.id);
    if (a.modifiedAt && (!g.newestChange || a.modifiedAt > g.newestChange)) g.newestChange = a.modifiedAt;
    for (const sid of a.sessionIds || []) {
      g.sessions.add(sid);
      if (costs.sessions[sid]?.possiblyRunning) g.inUse = true;
    }
    if (g.examples.length < 3 && !g.examples.includes(a.name)) g.examples.push(a.name);
  }
  const all = [...groups.values()]
    .map((g) => {
      // In a project, a group made of build outputs only is what the project's build makes again
      if (g.kind === 'unrecognised' && projectRoots.has(g.root) && [...g.kinds].every((k) => k === 'BUILD_OUTPUT' || k === 'DERIVED_DATA')) {
        Object.assign(g, { kind: 'remade', what: 'Build outputs: the project\'s build makes these again.' });
      }
      return { ...g, sessionCount: g.sessions.size, sessions: undefined, kinds: undefined };
    })
    .sort((x, y) => y.bytes - x.bytes || y.count - x.count);
  const open = all.filter((g) => !kept.has(g.key));
  const keptGroups = all.filter((g) => kept.has(g.key));
  return {
    groups: open.slice(0, MAX_REVIEW_GROUPS),
    otherGroups: Math.max(0, open.length - MAX_REVIEW_GROUPS),
    kept: keptGroups,
    count: open.reduce((s, g) => s + g.count, 0),
    bytes: open.reduce((s, g) => s + g.bytes, 0),
    // Files past the file limit are measured, not listed, so they are in no group
    notListed: state.scan?.overflow?.fileCount || 0
  };
}

/** The same groups for the window: no file ids, and the folder shown as `~/…` by the caller. */
export function reviewGroupsForClient(result) {
  const strip = ({ artifactIds, root, parts, ...g }) => ({ ...g, label: g.key });
  return { ...result, groups: result.groups.map(strip), kept: result.kept.map(strip) };
}

/** The folder Show in Finder opens for a group: everything before the first `*`. */
export function reviewGroupFolder(group) {
  const fixed = [];
  for (const p of group.parts) {
    if (p === '*') break;
    fixed.push(p);
  }
  return path.join(group.root, ...fixed);
}
