/**
 * What an AI app left on disk, summed up for a chat with that app (`artifact-atlas leftovers`).
 *
 * Read only: the scan runs in memory, nothing is written, moved or deleted. The output goes
 * into a conversation and so to the AI provider behind it. It therefore holds numbers by
 * default. Paths and session titles appear only with `details`, which the user asks for.
 * Prompt text never appears (AGENTS.md rule 6); a session is named by its stored title or
 * its ID, never by reading its transcript.
 */
import path from 'node:path';
import { computePromptCosts } from '../graph/prompt-costs.js';
import { sessionLabel } from '../graph/report.js';

export const LEFTOVER_APPS = ['claude', 'codex', 'cursor'];
const RISKS = ['LOW', 'REVIEW', 'HIGH', 'PROTECTED'];
const RISK_LABELS = {
  LOW: 'Safe to remove',
  REVIEW: 'Review first',
  HIGH: 'High risk',
  PROTECTED: 'Protected'
};
const DAY_MS = 86400000;
const MAX_ROWS = 8;

function add(map, key, art, bytes) {
  const row = map.get(key) || { count: 0, bytes: 0 };
  row.count += 1;
  row.bytes += bytes;
  map.set(key, row);
}

function rows(map, keyName) {
  return [...map.entries()]
    .map(([key, v]) => ({ [keyName]: key, ...v }))
    .sort((a, b) => b.bytes - a.bytes || b.count - a.count);
}

/** A session ID as the user may give it: the app's own ID or the atlas ID, or 8+ of its first characters. */
function findSessions(sessions, wanted) {
  const w = String(wanted || '').trim().toLowerCase();
  if (w.length < 8) return [];
  return sessions.filter((s) =>
    [s.externalSessionId, s.id].some((id) => id && String(id).toLowerCase().startsWith(w))
  );
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** `~/…` for a path in the home folder, else the path. */
function shortPath(p, homeDir) {
  if (homeDir && isInside(p, homeDir)) {
    const rel = path.relative(homeDir, p);
    return rel ? `~${path.sep}${rel}` : '~';
  }
  return p;
}

/**
 * @param state      the service's active state after a scan
 * @param sessionId  only this session's files (its own ID, or 8+ first characters)
 * @param projectDir only the sessions that ran in this project folder
 * @param details    include paths and session titles
 * @param unusedDays a safe file unchanged (and not opened, where recorded) this long is unused
 */
export function summarizeLeftovers(state, { sessionId = null, projectDir = null, details = false, unusedDays = 30, homeDir = null, now = Date.now() } = {}) {
  const sessions = state.sessions || [];
  const costs = computePromptCosts(state, { now });
  const label = (s) => (details ? sessionLabel(s) : `Session ${String(s.externalSessionId || s.id).slice(0, 8)}`);

  let focus = null;
  let scope = 'app';
  if (sessionId) {
    focus = findSessions(sessions, sessionId);
    scope = 'session';
  } else if (projectDir) {
    const dir = path.resolve(projectDir);
    const wsIds = new Set(
      (state.workspaces || []).filter((ws) => ws.canonicalPath && isInside(ws.canonicalPath, dir)).map((ws) => ws.id)
    );
    focus = sessions.filter((s) => s.workspaceId && wsIds.has(s.workspaceId));
    scope = 'project';
  }
  const focusIds = focus ? new Set(focus.map((s) => s.id)) : null;

  const live = (state.artifacts || []).filter(
    (a) => !a.quarantined && (!focusIds || (a.sessionIds || []).some((sid) => focusIds.has(sid)))
  );

  // Each physical file counts once, however many links or sessions it has
  const seen = new Set();
  const total = { count: 0, bytes: 0 };
  const byRisk = new Map();
  const byKind = new Map();
  const byOrigin = new Map();
  const byFolder = new Map();
  const unused = { count: 0, bytes: 0 };
  const cutoff = now - unusedDays * DAY_MS;
  for (const a of live) {
    const key = a.physicalInodeKey || a.canonicalPath;
    const bytes = seen.has(key) ? 0 : a.sizeBytes || 0;
    seen.add(key);
    total.count += 1;
    total.bytes += bytes;
    add(byRisk, a.cleanupClassification || 'REVIEW', a, bytes);
    add(byKind, a.artifactType || 'UNCLASSIFIED', a, bytes);
    add(byOrigin, a.provenanceConfidence || 'UNKNOWN', a, bytes);
    if (details && a.canonicalPath) add(byFolder, path.dirname(a.canonicalPath), a, bytes);
    if (a.cleanupClassification === 'LOW') {
      const changed = Date.parse(a.modifiedAt || '');
      const opened = Date.parse(a.accessedAt || '');
      if (Number.isFinite(changed) && changed <= cutoff && !(Number.isFinite(opened) && opened > cutoff)) {
        unused.count += 1;
        unused.bytes += bytes;
      }
    }
  }

  const sessionRows = (focus || sessions)
    .map((s) => {
      const c = costs.sessions[s.id] || {};
      return {
        id: String(s.externalSessionId || s.id),
        label: label(s),
        leftBehindCount: c.costCount || 0,
        leftBehindBytes: c.costBytes || 0,
        outputCount: c.parts?.output?.count || 0,
        lastActiveAt: c.lastActiveAt || s.endedAt || null,
        possiblyRunning: Boolean(c.possiblyRunning)
      };
    })
    .sort((a, b) => b.leftBehindBytes - a.leftBehindBytes);

  const scan = state.scan || {};
  return {
    app: state.application?.name || 'Unknown',
    scope,
    matchedSessions: focus ? focus.length : null,
    scan: {
      status: scan.status || null,
      truncated: Boolean(scan.truncated),
      fileLimit: scan.maxFilesLimit || null,
      measuredBeyondLimit:
        scan.overflow?.fileCount > 0 ? { count: scan.overflow.fileCount, bytes: scan.overflow.physicalBytes || 0 } : null,
      projectFoldersRead: Boolean(scan.scope?.projectFolders),
      sessionCount: sessions.length
    },
    total,
    byRisk: RISKS.map((r) => ({ risk: r, label: RISK_LABELS[r], ...(byRisk.get(r) || { count: 0, bytes: 0 }) })),
    byKind: rows(byKind, 'kind').slice(0, MAX_ROWS),
    byOrigin: rows(byOrigin, 'confidence'),
    unused: { days: unusedDays, ...unused },
    sessions: sessionRows.slice(0, MAX_ROWS),
    sessionsNotShown: Math.max(0, sessionRows.length - MAX_ROWS),
    folders: details
      ? rows(byFolder, 'folder').slice(0, MAX_ROWS).map((f) => ({ ...f, folder: shortPath(f.folder, homeDir) }))
      : null
  };
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(bytes) || 0;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

const kindName = (k) => k.charAt(0) + k.slice(1).toLowerCase().replace(/_/g, ' ');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Plain text for a chat: short, a few dozen lines at most. */
export function formatLeftovers(s) {
  const out = [];
  const where = s.scope === 'session' ? ' · one session' : s.scope === 'project' ? ' · sessions in this project' : '';
  out.push(`Artifact Atlas · ${s.app}${where}`);
  if (s.matchedSessions === 0) {
    out.push(s.scope === 'session' ? 'No session with that ID was found in the app\'s records.' : 'No session of this app ran in that folder.');
    return out.join('\n');
  }
  out.push(`${plural(s.total.count, 'file')}, ${formatBytes(s.total.bytes)} (each file counted once)`);
  if (s.scan.truncated) {
    const m = s.scan.measuredBeyondLimit;
    out.push(`The scan stopped listing at ${s.scan.fileLimit} files${m ? `; ${plural(m.count, 'more file')}, ${formatBytes(m.bytes)}, were measured but not listed` : ''}.`);
  }
  out.push('');
  out.push('Cleanup risk');
  for (const r of s.byRisk) out.push(`  ${r.label.padEnd(16)} ${String(r.count).padStart(7)}  ${formatBytes(r.bytes)}`);
  out.push(`  Unused ${s.unused.days}+ days (safe files) ${plural(s.unused.count, 'file')}, ${formatBytes(s.unused.bytes)}`);
  out.push('');
  out.push('Kinds');
  for (const k of s.byKind) out.push(`  ${kindName(k.kind).padEnd(16)} ${String(k.count).padStart(7)}  ${formatBytes(k.bytes)}`);
  out.push('');
  out.push('Origin');
  for (const o of s.byOrigin) out.push(`  ${kindName(o.confidence).padEnd(16)} ${String(o.count).padStart(7)}  ${formatBytes(o.bytes)}`);
  if (s.sessions.length) {
    out.push('');
    out.push(s.scope === 'app' ? 'Sessions that left the most behind' : 'Sessions');
    for (const r of s.sessions) {
      const flags = r.possiblyRunning ? ' · may still be running' : '';
      out.push(`  ${r.label} · ${plural(r.leftBehindCount, 'file')}, ${formatBytes(r.leftBehindBytes)} left behind${flags}`);
    }
    if (s.sessionsNotShown) out.push(`  … ${s.sessionsNotShown} more`);
  }
  if (s.folders) {
    out.push('');
    out.push('Largest folders');
    for (const f of s.folders) out.push(`  ${f.folder} · ${plural(f.count, 'file')}, ${formatBytes(f.bytes)}`);
  }
  out.push('');
  out.push('Counts are lower bounds: files made by commands a session ran are not in its record.');
  if (!s.scan.projectFoldersRead) out.push('Project folders were not walked; only files a session wrote there are counted.');
  out.push('Nothing was moved or deleted. To clean up, open Artifact Atlas: files go to its Quarantine first and can be put back.');
  return out.join('\n');
}
