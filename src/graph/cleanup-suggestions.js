/**
 * Suggested cleanups: what an app keeps in its own data folders and has not touched for a
 * while, grouped by folder so it can be cleared in one step. The files go to the Quarantine and
 * are deleted after SCHEDULED_DELETION_DAYS unless their app makes them again (AGENTS.md rule 2).
 *
 * Only files the app keeps for itself are offered: inside the app's data folders, safe to
 * remove, or review first where the kind or folder says the app makes it again (caches,
 * temporary files, logs), with a known origin, not a session record, user content,
 * model data or checkpoint, not shared between sessions, not of a session that may be running,
 * unchanged for minDays and not opened in that time where the system records it.
 */
import crypto from 'node:crypto';
import { computePromptCosts } from './prompt-costs.js';
import { KEPT_FOLDERS, REMADE_FOLDERS } from '../classification/app-folders.js';

export const SUGGESTION_DAY_CHOICES = [7, 30, 90];
export const SUGGESTION_DEFAULT_DAYS = 7;
const MAX_GROUPS = 12;
const NEVER_SUGGESTED = new Set(['SESSION_HISTORY', 'USER_CONTENT', 'MODEL_DATA', 'CHECKPOINT']);
const SUGGESTED_RISKS = new Set(['LOW', 'REVIEW']);
// A review-first file is offered only when what it is, or the folder it is in, says the app
// can make it again: caches, temporary files, logs and build outputs. Settings, skills,
// plug-ins, backups and memory files in the same data folders never are.
// Temporary files are not among them: that kind can rest on a name alone (a .bak backup)
const REMADE_KINDS = new Set(['REGENERABLE_CACHE', 'LOG', 'BUILD_OUTPUT']);

const DAY_MS = 86400000;

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');

/** The app's data folder a file is inside, or null: a file elsewhere is never suggested. */
export function dataFolderOf(filePath, dataFolders) {
  const file = norm(filePath);
  let best = null;
  for (const root of dataFolders) {
    const r = norm(root);
    if (r && file.startsWith(`${r}/`) && (!best || r.length > norm(best).length)) best = root;
  }
  return best;
}

function folderParts(filePath, root) {
  return norm(filePath).slice(norm(root).length + 1).split('/').slice(0, -1).map((p) => p.toLowerCase());
}

/** A review-first file the app makes again: in a cache, temp or log folder, or a cache, log or build output by kind, and not in a folder the user keeps things in. */
function remadeByApp(a, root) {
  const parts = folderParts(a.canonicalPath, root);
  const tmpIndex = parts.findIndex((p) => REMADE_FOLDERS.has(p));
  // Below a temp or cache folder anything goes (an unpacked plug-in); above it, a kept folder rules it out
  const above = tmpIndex === -1 ? parts : parts.slice(0, tmpIndex);
  if (above.some((p) => KEPT_FOLDERS.has(p))) return false;
  return tmpIndex !== -1 || REMADE_KINDS.has(a.artifactType);
}

/** The files that may be suggested, as of `now`. */
export function suggestionCandidates(state, { minDays = SUGGESTION_DEFAULT_DAYS, now = Date.now() } = {}) {
  const cutoff = now - minDays * DAY_MS;
  const costs = computePromptCosts(state, { now });
  const running = (a) => (a.sessionIds || []).some((sid) => costs.sessions[sid]?.possiblyRunning);
  const dataFolders = (state.application?.knownDataDirectories || []).map((d) => d.path).filter(Boolean);
  return (state.artifacts || []).filter((a) => {
    if (a.quarantined || !SUGGESTED_RISKS.has(a.cleanupClassification)) return false;
    // Only inside the app's own data folders: never a file a session wrote anywhere else
    const root = dataFolderOf(a.canonicalPath, dataFolders);
    if (!root) return false;
    if (a.cleanupClassification === 'REVIEW' && !remadeByApp(a, root)) {
      return false;
    }
    if (a.workspaceId || NEVER_SUGGESTED.has(a.artifactType)) return false;
    if (a.provenanceConfidence === 'UNKNOWN') return false;
    if ((a.sessionIds || []).length > 1 || running(a)) return false;
    const changed = Date.parse(a.modifiedAt || '');
    if (!Number.isFinite(changed) || changed > cutoff) return false;
    const opened = Date.parse(a.accessedAt || '');
    return !(Number.isFinite(opened) && opened > cutoff);
  });
}

/**
 * The folder a file is suggested under: the scanned data folder it is in, plus the first folder
 * below it (`~/.codex` + `.tmp`), so a suggestion names one place the user recognises.
 */
export function suggestionFolder(filePath, roots) {
  const best = dataFolderOf(filePath, roots);
  if (!best) return { folder: null, topLevel: false };
  const rest = norm(filePath).slice(norm(best).length + 1).split('/');
  // A file directly in the data folder is grouped as that folder's own files, not the folder
  if (rest.length <= 1) return { folder: best, topLevel: true };
  const sep = String(best).includes('\\') && !String(best).includes('/') ? '\\' : '/';
  return { folder: `${String(best).replace(/[\\/]+$/, '')}${sep}${rest[0]}`, topLevel: false };
}

export function groupId(folder, topLevel = false) {
  return `sg_${crypto.createHash('sha256').update(`${topLevel ? 'top:' : ''}${norm(folder)}`).digest('hex').slice(0, 16)}`;
}

/** Candidates grouped by folder, largest first. Each file is counted once by its inode. */
export function groupSuggestions(state, candidates) {
  const roots = (state.application?.knownDataDirectories || []).map((d) => d.path).filter(Boolean);
  const groups = new Map();
  const seen = new Set();
  for (const a of candidates) {
    const { folder, topLevel } = suggestionFolder(a.canonicalPath, roots);
    if (!folder) continue;
    const id = groupId(folder, topLevel);
    const g =
      groups.get(id) ||
      { id, folder, topLevel, count: 0, bytes: 0, safeCount: 0, reviewCount: 0, newestChange: null, kinds: new Map(), artifactIds: [] };
    const key = a.physicalInodeKey || a.canonicalPath;
    const bytes = seen.has(key) ? 0 : a.sizeBytes || 0;
    seen.add(key);
    g.count += 1;
    g.bytes += bytes;
    if (a.cleanupClassification === 'LOW') g.safeCount += 1;
    else g.reviewCount += 1;
    if (a.modifiedAt && (!g.newestChange || a.modifiedAt > g.newestChange)) g.newestChange = a.modifiedAt;
    const k = g.kinds.get(a.artifactType) || { artifactType: a.artifactType, count: 0, bytes: 0 };
    k.count += 1;
    k.bytes += bytes;
    g.kinds.set(a.artifactType, k);
    g.artifactIds.push(a.id);
    groups.set(id, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, kinds: [...g.kinds.values()].sort((x, y) => y.bytes - x.bytes).slice(0, 3) }))
    .sort((x, y) => y.bytes - x.bytes || y.count - x.count);
}

/** What the Insights card shows: the largest groups, without their file lists. */
export function summarizeSuggestions(state, { minDays = SUGGESTION_DEFAULT_DAYS, now = Date.now() } = {}) {
  const groups = groupSuggestions(state, suggestionCandidates(state, { minDays, now }));
  const shown = groups.slice(0, MAX_GROUPS);
  return {
    minDays,
    dayChoices: SUGGESTION_DAY_CHOICES,
    groups: shown.map(({ artifactIds, ...g }) => g),
    otherGroups: groups.length - shown.length,
    count: groups.reduce((s, g) => s + g.count, 0),
    bytes: groups.reduce((s, g) => s + g.bytes, 0)
  };
}
