/**
 * Suggested cleanups: what an app keeps in its own data folders and has not touched for a
 * while, grouped by folder so it can be cleared in one step. The files go to the Quarantine and
 * are deleted after SCHEDULED_DELETION_DAYS unless their app makes them again (AGENTS.md rule 2).
 *
 * Only files the app keeps for itself are offered: safe to remove or review first, in the app's
 * data folders (never a project folder), with a known origin, not a session record, user content,
 * model data or checkpoint, not shared between sessions, not of a session that may be running,
 * unchanged for minDays and not opened in that time where the system records it.
 */
import crypto from 'node:crypto';
import { computePromptCosts } from './prompt-costs.js';

export const SUGGESTION_DAY_CHOICES = [7, 30, 90];
export const SUGGESTION_DEFAULT_DAYS = 7;
const MAX_GROUPS = 12;
const NEVER_SUGGESTED = new Set(['SESSION_HISTORY', 'USER_CONTENT', 'MODEL_DATA', 'CHECKPOINT']);
const SUGGESTED_RISKS = new Set(['LOW', 'REVIEW']);
const DAY_MS = 86400000;

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');

/** The files that may be suggested, as of `now`. */
export function suggestionCandidates(state, { minDays = SUGGESTION_DEFAULT_DAYS, now = Date.now() } = {}) {
  const cutoff = now - minDays * DAY_MS;
  const costs = computePromptCosts(state, { now });
  const running = (a) => (a.sessionIds || []).some((sid) => costs.sessions[sid]?.possiblyRunning);
  return (state.artifacts || []).filter((a) => {
    if (a.quarantined || !SUGGESTED_RISKS.has(a.cleanupClassification)) return false;
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
  const file = norm(filePath);
  let best = null;
  for (const root of roots) {
    const r = norm(root);
    if (file.startsWith(`${r}/`) && (!best || r.length > norm(best).length)) best = root;
  }
  if (!best) {
    const cut = file.lastIndexOf('/');
    return cut > 0 ? filePath.slice(0, cut) : filePath;
  }
  const rest = file.slice(norm(best).length + 1).split('/');
  if (rest.length <= 1) return best;
  const sep = String(best).includes('\\') && !String(best).includes('/') ? '\\' : '/';
  return `${String(best).replace(/[\\/]+$/, '')}${sep}${rest[0]}`;
}

export function groupId(folder) {
  return `sg_${crypto.createHash('sha256').update(norm(folder)).digest('hex').slice(0, 16)}`;
}

/** Candidates grouped by folder, largest first. Each file is counted once by its inode. */
export function groupSuggestions(state, candidates) {
  // The folders the scan was allowed to walk (the app's data folders)
  const roots = state.authorizedRoots || [];
  const groups = new Map();
  const seen = new Set();
  for (const a of candidates) {
    const folder = suggestionFolder(a.canonicalPath, roots);
    const id = groupId(folder);
    const g =
      groups.get(id) ||
      { id, folder, count: 0, bytes: 0, safeCount: 0, reviewCount: 0, newestChange: null, kinds: new Map(), artifactIds: [] };
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
