import fs from 'node:fs';
import path from 'node:path';
import { claudeTempLocations } from '../discovery/claude-temp.js';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  ProvenanceConfidence,
  createWorkspaceModel,
  createSessionModel,
  createOperationModel
} from '../models/entities.js';

function normalizeFileUriOrPath(rawPath, baseCwd = null) {
  if (!rawPath || typeof rawPath !== 'string') {
    return null;
  }
  let cleaned = rawPath.trim();
  if (cleaned.startsWith('file://')) {
    try {
      // Handles drive letters and encoded characters ("file:///c%3A/Users/me")
      cleaned = fileURLToPath(cleaned);
    } catch {
      cleaned = decodeURIComponent(cleaned.replace(/^file:\/\//, ''));
    }
  }
  if (!path.isAbsolute(cleaned) && baseCwd) {
    return path.resolve(baseCwd, cleaned);
  }
  return path.resolve(cleaned);
}

function safeWalkJsonlFiles(rootDir, maxDepth = 5, currentDepth = 0) {
  const results = [];
  if (currentDepth > maxDepth || !fs.existsSync(rootDir)) {
    return results;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...safeWalkJsonlFiles(fullPath, maxDepth, currentDepth + 1));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * 1. Claude Code adapter: the Claude Code CLI and the Code view of the Claude desktop app
 */
export class ClaudeCodeAdapter {
  constructor() {
    this.id = 'claude-code';
    this.displayName = 'Claude Code (CLI and the Claude app)';
    this.isSpecializedAIAdapter = true;
  }

  matches({ name = '', bundleId = '' }) {
    const lowerName = String(name).toLowerCase();
    const lowerBundle = String(bundleId).toLowerCase();
    return (
      lowerBundle.includes('anthropic.claude') ||
      lowerName.includes('claude')
    );
  }

  getCandidateDataDirectories({ bundleId, platformServices }) {
    const home = platformServices.homeDir;
    if (platformServices.isWindowsLayout) {
      const appData = platformServices.getWindowsAppDataDirs();
      return [
        { role: 'CLAUDE_CLI_HOME', path: platformServices.appHome('claude') },
        { role: 'APP_SUPPORT', path: path.join(appData.roaming, 'Claude') },
        { role: 'CLI_CACHE', path: path.join(appData.local, 'claude-cli-nodejs') },
        ...claudeTempLocations(platformServices)
      ];
    }
    const dirs = [
      { role: 'CLAUDE_CLI_HOME', path: platformServices.appHome('claude') },
      { role: 'APP_SUPPORT', path: path.join(home, 'Library', 'Application Support', 'Claude') },
      { role: 'LOGS', path: path.join(home, 'Library', 'Logs', 'Claude') },
      {
        role: 'CACHES',
        path: path.join(home, 'Library', 'Caches', bundleId || 'com.anthropic.claudefordesktop')
      },
      // The command-line tool's own cache (MCP server logs), on macOS and on Linux
      { role: 'CLI_CACHE', path: path.join(home, 'Library', 'Caches', 'claude-cli-nodejs') },
      { role: 'CLI_CACHE', path: path.join(home, '.cache', 'claude-cli-nodejs') },
      ...claudeTempLocations(platformServices)
    ];
    return dirs;
  }

  parseProvenanceRecords(args) {
    const steps = this.parseProvenanceSteps(args);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }

  /**
   * The same, a transcript at a time with a pause between them, so a scan of gigabytes of
   * session records shows its progress and can be cancelled. onProgress gets
   * { recordsDone, recordBytes }.
   */
  async parseProvenanceRecordsAsync(args, { signal = null, onProgress = () => {} } = {}) {
    const steps = this.parseProvenanceSteps(args);
    let step = steps.next();
    while (!step.done) {
      onProgress(step.value);
      await new Promise((resolve) => setImmediate(resolve));
      if (signal?.aborted) {
        steps.return();
        throw new Error('SCAN_CANCELLED');
      }
      step = steps.next();
    }
    return step.value;
  }

  *parseProvenanceSteps({ application, authorizedRoots, platformServices }) {
    // realpath once per path, not once per line
    const realMemo = new Map();
    const real = (p) => {
      let r = realMemo.get(p);
      if (r === undefined) {
        r = platformServices.resolveRealPathSafe(p);
        realMemo.set(p, r);
      }
      return r;
    };
    let recordsDone = 0;
    let recordBytes = 0;
    const workspacesByPath = new Map();
    const sessionsById = new Map();
    const operations = [];
    const malformedRecords = [];

    const claudeProjectsDir = path.join(platformServices.appHome('claude'), 'projects');
    const candidateDirs = [claudeProjectsDir];
    for (const root of authorizedRoots) {
      const nestedProjects = path.join(root, '.claude', 'projects');
      if (fs.existsSync(nestedProjects) && !candidateDirs.includes(nestedProjects)) {
        candidateDirs.push(nestedProjects);
      }
    }

    for (const projectsRoot of candidateDirs) {
      if (!fs.existsSync(projectsRoot)) {
        continue;
      }
      // A session's subagents write their own transcripts under <session>/subagents/, and
      // their records carry the parent's session ID. Main transcripts are read first so a
      // session's record is its own file, whatever order the folder lists them in.
      const isSubagentTranscript = (p) => path.basename(path.dirname(p)) === 'subagents';
      const jsonlFiles = safeWalkJsonlFiles(projectsRoot, 4).sort(
        (a, b) => Number(isSubagentTranscript(a)) - Number(isSubagentTranscript(b)) || a.localeCompare(b)
      );
      for (const jsonlPath of jsonlFiles) {
        const read = readTranscriptStructure(jsonlPath);
        if (!read) {
          continue;
        }
        recordsDone += 1;
        recordBytes += read.bytes;
        malformedRecords.push(...read.malformed);
        const defaultSessionId = path.basename(jsonlPath, '.jsonl');
        let opSeq = 0;

        for (const { lineIdx, record } of read.records) {

          const externalSessionId = String(record.sessionId || record.session_id || defaultSessionId);
          const cwd = record.cwd ? real(record.cwd) : null;
          const timestamp = record.timestamp || record.createdAt || null;

          let workspace = null;
          if (cwd) {
            if (!workspacesByPath.has(cwd)) {
              workspacesByPath.set(
                cwd,
                createWorkspaceModel({
                  name: path.basename(cwd),
                  canonicalPath: cwd,
                  applicationIds: [application.id],
                  hasGitRepository: fs.existsSync(path.join(cwd, '.git'))
                })
              );
            }
            workspace = workspacesByPath.get(cwd);
          }

          if (!sessionsById.has(externalSessionId)) {
            sessionsById.set(
              externalSessionId,
              createSessionModel({
                externalSessionId,
                applicationId: application.id,
                workspaceId: workspace ? workspace.id : null,
                title: record.summary || record.sessionTitle || `Claude Session ${externalSessionId.slice(0, 8)}`,
                startedAt: timestamp,
                endedAt: timestamp,
                sourcePath: real(jsonlPath),
                adapterId: this.id,
                operationCount: 0
              })
            );
          }

          const session = sessionsById.get(externalSessionId);
          // The file named after the session is its main transcript
          if (path.basename(jsonlPath, '.jsonl') === externalSessionId && !isSubagentTranscript(jsonlPath)) {
            session.sourcePath = real(jsonlPath);
          }
          if (workspace && !session.workspaceId) {
            session.workspaceId = workspace.id;
          }
          if (timestamp) {
            if (!session.startedAt || timestamp < session.startedAt) {
              session.startedAt = timestamp;
            }
            if (!session.endedAt || timestamp > session.endedAt) {
              session.endedAt = timestamp;
            }
          }

          // Extract tool_use blocks without storing any conversation text
          const contentBlocks = Array.isArray(record?.message?.content)
            ? record.message.content
            : record.type === 'tool_use'
              ? [record]
              : [];

          for (const block of contentBlocks) {
            if (!block || block.type !== 'tool_use') {
              continue;
            }

            const toolName = String(block.name || 'unknown_tool');
            const input = block.input || {};
            const rawTarget =
              input.file_path ||
              input.path ||
              input.target_file ||
              input.notebook_path ||
              input.output_file ||
              null;

            const normalizedTarget = rawTarget
              ? normalizeFileUriOrPath(rawTarget, cwd)
              : null;

            let operationType = 'TOOL_CALL';
            const lowerTool = toolName.toLowerCase();
            if (lowerTool === 'write' || lowerTool === 'create_file' || lowerTool === 'write_to_file') {
              operationType = 'WRITE';
            } else if (
              lowerTool === 'edit' ||
              lowerTool === 'multiedit' ||
              lowerTool === 'str_replace_editor' ||
              lowerTool === 'notebookedit'
            ) {
              operationType = 'EDIT';
            } else if (lowerTool === 'bash' || lowerTool === 'run_command') {
              operationType = 'SHELL';
            }

            if (normalizedTarget || operationType === 'SHELL') {
              opSeq += 1;
              session.operationCount += 1;
              operations.push(
                createOperationModel({
                  sessionId: session.id,
                  applicationId: application.id,
                  workspaceId: session.workspaceId,
                  sequence: opSeq,
                  toolName,
                  operationType,
                  targetPath: normalizedTarget
                    ? real(normalizedTarget)
                    : null,
                  timestamp,
                  sourceRecordRef: `${real(jsonlPath)}#L${lineIdx + 1}`,
                  confidence: normalizedTarget
                    ? ProvenanceConfidence.VERIFIED
                    : ProvenanceConfidence.INFERRED
                })
              );
            }

            // Support multi-file edit arrays if present
            if (Array.isArray(input.edits)) {
              for (const subEdit of input.edits) {
                const subPath = subEdit?.file_path || subEdit?.path;
                if (subPath) {
                  opSeq += 1;
                  session.operationCount += 1;
                  const resolvedSub = real(
                    normalizeFileUriOrPath(subPath, cwd)
                  );
                  operations.push(
                    createOperationModel({
                      sessionId: session.id,
                      applicationId: application.id,
                      workspaceId: session.workspaceId,
                      sequence: opSeq,
                      toolName,
                      operationType: 'EDIT',
                      targetPath: resolvedSub,
                      timestamp,
                      sourceRecordRef: `${real(jsonlPath)}#L${lineIdx + 1}`,
                      confidence: ProvenanceConfidence.VERIFIED
                    })
                  );
                }
              }
            }
          }
        }
        yield { recordsDone, recordBytes };
      }
    }

    return {
      workspaces: Array.from(workspacesByPath.values()),
      sessions: Array.from(sessionsById.values()),
      operations,
      malformedRecords
    };
  }
}

/**
 * The structure of one Claude Code transcript: per line only the session ID, time, folder,
 * stored title and the tool calls with the paths they name. Never message text. Kept in memory
 * while the file's size and change time stay the same, so a scan after a cancelled one, or the
 * next scan, reads only the transcripts that changed.
 */
const transcriptCache = new Map();
const PATH_KEYS = ['file_path', 'path', 'target_file', 'notebook_path', 'output_file'];

function toolUseStructure(block) {
  const input = block.input && typeof block.input === 'object' ? block.input : {};
  const kept = {};
  for (const k of PATH_KEYS) if (typeof input[k] === 'string') kept[k] = input[k];
  if (Array.isArray(input.edits)) {
    kept.edits = input.edits.map((e) => ({ file_path: e?.file_path, path: e?.path }));
  }
  return { type: 'tool_use', name: block.name, input: kept };
}

function recordStructure(record) {
  const blocks = Array.isArray(record?.message?.content)
    ? record.message.content.filter((b) => b && b.type === 'tool_use').map(toolUseStructure)
    : record?.type === 'tool_use'
      ? [toolUseStructure(record)]
      : [];
  return {
    sessionId: record.sessionId || record.session_id || null,
    cwd: typeof record.cwd === 'string' ? record.cwd : null,
    timestamp: record.timestamp || record.createdAt || null,
    summary: typeof record.summary === 'string' ? record.summary : null,
    sessionTitle: typeof record.sessionTitle === 'string' ? record.sessionTitle : null,
    message: { content: blocks }
  };
}

export function readTranscriptStructure(jsonlPath) {
  const st = fs.lstatSync(jsonlPath, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return null;
  const cached = transcriptCache.get(jsonlPath);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached;
  let content;
  try {
    content = fs.readFileSync(jsonlPath, 'utf8');
  } catch {
    return null;
  }
  const records = [];
  const malformed = [];
  let lineIdx = -1;
  let from = 0;
  while (from <= content.length) {
    let to = content.indexOf('\n', from);
    if (to === -1) to = content.length;
    lineIdx += 1;
    const line = content.slice(from, to).trim();
    from = to + 1;
    if (!line) continue;
    // A large line without a tool call is a tool's output or pasted text: it holds nothing read
    // here (the session's ID, time and folder are on the other lines), so it is not parsed
    if (line.length > 65536 && !line.includes('"tool_use"')) continue;
    try {
      records.push({ lineIdx, record: recordStructure(JSON.parse(line)) });
    } catch (err) {
      malformed.push({ sourcePath: jsonlPath, lineNumber: lineIdx + 1, error: err.message });
    }
  }
  const result = { size: st.size, mtimeMs: st.mtimeMs, bytes: content.length, records, malformed };
  transcriptCache.set(jsonlPath, result);
  if (transcriptCache.size > 20000) transcriptCache.delete(transcriptCache.keys().next().value);
  return result;
}

/**
 * 2. Cursor AI IDE Adapter
 */
export class CursorAdapter {
  constructor() {
    this.id = 'cursor-ide';
    this.displayName = 'Cursor';
    this.isSpecializedAIAdapter = true;
  }

  matches({ name = '', bundleId = '' }) {
    const lowerName = String(name).toLowerCase();
    const lowerBundle = String(bundleId).toLowerCase();
    return (
      lowerBundle.includes('230313mzl4w4u92') ||
      lowerBundle.includes('cursor') ||
      lowerName === 'cursor' ||
      lowerName.includes('cursor')
    );
  }

  getCandidateDataDirectories({ bundleId, platformServices }) {
    const home = platformServices.homeDir;
    if (platformServices.isWindowsLayout) {
      const appData = platformServices.getWindowsAppDataDirs();
      return [
        { role: 'CURSOR_DOTDIR', path: path.join(home, '.cursor') },
        { role: 'APP_SUPPORT', path: path.join(appData.roaming, 'Cursor') }
      ];
    }
    return [
      { role: 'CURSOR_DOTDIR', path: path.join(home, '.cursor') },
      { role: 'APP_SUPPORT', path: path.join(home, 'Library', 'Application Support', 'Cursor') },
      { role: 'LOGS', path: path.join(home, 'Library', 'Logs', 'Cursor') },
      {
        role: 'CACHES',
        path: path.join(home, 'Library', 'Caches', bundleId || 'com.todesktop.230313mzl4w4u92')
      }
    ];
  }

  parseProvenanceRecords(args) {
    const steps = this.parseProvenanceSteps(args);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }

  /** A workspace's records at a time, with progress and Cancel, like the Claude Code reader. */
  async parseProvenanceRecordsAsync(args, { signal = null, onProgress = () => {} } = {}) {
    const steps = this.parseProvenanceSteps(args);
    let step = steps.next();
    while (!step.done) {
      onProgress(step.value);
      await new Promise((resolve) => setImmediate(resolve));
      if (signal?.aborted) {
        steps.return();
        throw new Error('SCAN_CANCELLED');
      }
      step = steps.next();
    }
    return step.value;
  }

  *parseProvenanceSteps({ application, authorizedRoots, platformServices }) {
    let recordsDone = 0;
    const workspacesByPath = new Map();
    const sessionsById = new Map();
    const operations = [];
    const malformedRecords = [];

    const storageRoots = [
      platformServices.isWindowsLayout
        ? path.join(platformServices.getWindowsAppDataDirs().roaming, 'Cursor', 'User', 'workspaceStorage')
        : path.join(platformServices.homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage')
    ];

    for (const root of authorizedRoots) {
      const candidate = path.join(root, 'User', 'workspaceStorage');
      if (fs.existsSync(candidate) && !storageRoots.includes(candidate)) {
        storageRoots.push(candidate);
      }
    }

    for (const storageRoot of storageRoots) {
      if (!fs.existsSync(storageRoot)) {
        continue;
      }

      let bucketEntries = [];
      try {
        bucketEntries = fs.readdirSync(storageRoot, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const bucket of bucketEntries) {
        if (!bucket.isDirectory() || bucket.isSymbolicLink()) {
          continue;
        }
        const bucketDir = path.join(storageRoot, bucket.name);
        const workspaceJsonPath = path.join(bucketDir, 'workspace.json');
        let workspaceFolder = null;
        let workspaceModel = null;

        if (fs.existsSync(workspaceJsonPath)) {
          try {
            const wsRaw = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf8'));
            if (wsRaw.folder) {
              workspaceFolder = platformServices.resolveRealPathSafe(
                normalizeFileUriOrPath(wsRaw.folder)
              );
              if (!workspacesByPath.has(workspaceFolder)) {
                workspacesByPath.set(
                  workspaceFolder,
                  createWorkspaceModel({
                    name: path.basename(workspaceFolder),
                    canonicalPath: workspaceFolder,
                    applicationIds: [application.id],
                    hasGitRepository: fs.existsSync(path.join(workspaceFolder, '.git'))
                  })
                );
              }
              workspaceModel = workspacesByPath.get(workspaceFolder);
            }
          } catch (err) {
            malformedRecords.push({
              sourcePath: workspaceJsonPath,
              lineNumber: 1,
              error: err.message
            });
          }
        }

        // Real Cursor installs keep the composer index inside the workspace's VS Code state
        // database. Only structural metadata is read (composer id and timestamps); conversation
        // titles and message bodies are never copied.
        const stateDbPath = path.join(bucketDir, 'state.vscdb');
        if (fs.existsSync(stateDbPath)) {
          const composers = readCursorComposerIndex(stateDbPath, malformedRecords);
          for (const comp of composers) {
            if (sessionsById.has(comp.composerId)) {
              continue;
            }
            sessionsById.set(
              comp.composerId,
              createSessionModel({
                externalSessionId: comp.composerId,
                applicationId: application.id,
                workspaceId: workspaceModel ? workspaceModel.id : null,
                title: `Cursor Composer ${comp.composerId.slice(0, 8)}`,
                startedAt: comp.createdAt,
                endedAt: comp.updatedAt || comp.createdAt,
                sourcePath: platformServices.resolveRealPathSafe(stateDbPath),
                adapterId: this.id,
                operationCount: 0
              })
            );
          }
        }

        const composerPath = path.join(bucketDir, 'composerData.json');
        if (fs.existsSync(composerPath)) {
          try {
            const composerRaw = JSON.parse(fs.readFileSync(composerPath, 'utf8'));
            const composers = Array.isArray(composerRaw.allComposers)
              ? composerRaw.allComposers
              : [];

            for (const comp of composers) {
              const composerId = String(comp.composerId || comp.id || `cursor_${bucket.name}`);
              const session = createSessionModel({
                externalSessionId: composerId,
                applicationId: application.id,
                workspaceId: workspaceModel ? workspaceModel.id : null,
                title: comp.name || `Cursor Composer ${composerId.slice(0, 8)}`,
                startedAt: comp.createdAt || null,
                endedAt: comp.updatedAt || comp.createdAt || null,
                sourcePath: platformServices.resolveRealPathSafe(composerPath),
                adapterId: this.id,
                operationCount: 0
              });
              sessionsById.set(composerId, session);

              const fileOps = Array.isArray(comp.operations) ? comp.operations : [];
              let seq = 0;
              for (const fop of fileOps) {
                const rawTarget = fop.filePath || fop.uri || fop.targetPath;
                if (!rawTarget) {
                  continue;
                }
                seq += 1;
                session.operationCount += 1;
                const resolvedTarget = platformServices.resolveRealPathSafe(
                  normalizeFileUriOrPath(rawTarget, workspaceFolder)
                );
                operations.push(
                  createOperationModel({
                    sessionId: session.id,
                    applicationId: application.id,
                    workspaceId: session.workspaceId,
                    sequence: seq,
                    toolName: fop.tool || 'CursorComposerApply',
                    operationType: fop.action === 'create' ? 'WRITE' : 'EDIT',
                    targetPath: resolvedTarget,
                    timestamp: fop.timestamp || comp.updatedAt || null,
                    sourceRecordRef: `${platformServices.resolveRealPathSafe(composerPath)}#${composerId}:${seq}`,
                    confidence: ProvenanceConfidence.VERIFIED
                  })
                );
              }
            }
          } catch (err) {
            malformedRecords.push({
              sourcePath: composerPath,
              lineNumber: 1,
              error: err.message
            });
          }
        }
        recordsDone += 1;
        yield { recordsDone, recordBytes: 0 };
      }
    }

    return {
      workspaces: Array.from(workspacesByPath.values()),
      sessions: Array.from(sessionsById.values()),
      operations,
      malformedRecords
    };
  }
}

/**
 * 3. Codex adapter: the Codex CLI and the Codex view of the ChatGPT desktop app, which
 * replaced the separate Codex app in July 2026. Both keep their records in ~/.codex.
 */
export class CodexAdapter {
  constructor() {
    this.id = 'codex-cli';
    this.displayName = 'Codex (CLI and the ChatGPT app)';
    this.isSpecializedAIAdapter = true;
  }

  matches({ name = '', bundleId = '' }) {
    const lowerName = String(name).toLowerCase();
    const lowerBundle = String(bundleId).toLowerCase();
    return lowerBundle.includes('openai.codex') || lowerName.includes('codex');
  }

  getCandidateDataDirectories({ bundleId, platformServices }) {
    const home = platformServices.homeDir;
    if (platformServices.isWindowsLayout) {
      return [{ role: 'CODEX_HOME', path: platformServices.appHome('codex') }];
    }
    return [
      { role: 'CODEX_HOME', path: platformServices.appHome('codex') },
      { role: 'APP_SUPPORT', path: path.join(home, 'Library', 'Application Support', 'Codex') },
      { role: 'CACHES', path: path.join(home, 'Library', 'Caches', bundleId || 'com.openai.codex') }
    ];
  }

  parseProvenanceRecords(args) {
    const steps = this.parseProvenanceSteps(args);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }

  /** A rollout at a time, with progress and Cancel, like the Claude Code reader. */
  async parseProvenanceRecordsAsync(args, { signal = null, onProgress = () => {} } = {}) {
    const steps = this.parseProvenanceSteps(args);
    let step = steps.next();
    while (!step.done) {
      onProgress(step.value);
      await new Promise((resolve) => setImmediate(resolve));
      if (signal?.aborted) {
        steps.return();
        throw new Error('SCAN_CANCELLED');
      }
      step = steps.next();
    }
    return step.value;
  }

  *parseProvenanceSteps({ application, authorizedRoots, platformServices }) {
    const workspacesByPath = new Map();
    const sessionsById = new Map();
    const operations = [];
    const malformedRecords = [];
    const realMemo = new Map();
    const real = (p) => {
      let r = realMemo.get(p);
      if (r === undefined) {
        r = platformServices.resolveRealPathSafe(p);
        realMemo.set(p, r);
      }
      return r;
    };
    let recordsDone = 0;
    let recordBytes = 0;

    // Live sessions, and the ones Codex archived (same rollout files, in archived_sessions)
    const codexHome = platformServices.appHome('codex');
    const candidateRoots = [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')];
    for (const root of authorizedRoots) {
      for (const name of ['sessions', 'archived_sessions']) {
        const sub = path.join(root, '.codex', name);
        if (fs.existsSync(sub) && !candidateRoots.includes(sub)) {
          candidateRoots.push(sub);
        }
      }
    }

    for (const root of candidateRoots) {
      if (!fs.existsSync(root)) {
        continue;
      }
      for (const rolloutPath of safeWalkJsonlFiles(root, 5)) {
        const read = readRolloutStructure(rolloutPath);
        if (!read) continue;
        recordsDone += 1;
        recordBytes += read.bytes;
        malformedRecords.push(...read.malformed);
        const sourcePath = real(rolloutPath);
        let seq = 0;
        for (const { lineIdx, rec } of read.records) {
          const sessionId = String(rec.sessionId || read.fileSessionId);
          const cwd = rec.cwd ? real(rec.cwd) : null;
          let workspace = null;
          if (cwd) {
            if (!workspacesByPath.has(cwd)) {
              workspacesByPath.set(
                cwd,
                createWorkspaceModel({
                  name: path.basename(cwd),
                  canonicalPath: cwd,
                  applicationIds: [application.id],
                  hasGitRepository: fs.existsSync(path.join(cwd, '.git'))
                })
              );
            }
            workspace = workspacesByPath.get(cwd);
          }
          if (!sessionsById.has(sessionId)) {
            sessionsById.set(
              sessionId,
              createSessionModel({
                externalSessionId: sessionId,
                applicationId: application.id,
                workspaceId: workspace ? workspace.id : null,
                title: rec.title || `Codex Rollout ${sessionId.slice(0, 8)}`,
                startedAt: rec.timestamp || null,
                endedAt: rec.timestamp || null,
                sourcePath,
                adapterId: this.id,
                operationCount: 0
              })
            );
          }
          const session = sessionsById.get(sessionId);
          if (workspace && !session.workspaceId) session.workspaceId = workspace.id;
          if (rec.timestamp) {
            if (!session.startedAt || rec.timestamp < session.startedAt) session.startedAt = rec.timestamp;
            if (!session.endedAt || rec.timestamp > session.endedAt) session.endedAt = rec.timestamp;
          }
          for (const op of rec.ops) {
            seq += 1;
            session.operationCount += 1;
            const baseDir = cwd || (session.workspaceId ? [...workspacesByPath.values()].find((w) => w.id === session.workspaceId)?.canonicalPath : null);
            operations.push(
              createOperationModel({
                sessionId: session.id,
                applicationId: application.id,
                workspaceId: session.workspaceId,
                sequence: seq,
                toolName: op.toolName,
                operationType: op.operationType,
                targetPath: real(normalizeFileUriOrPath(op.target, baseDir)),
                timestamp: rec.timestamp || null,
                sourceRecordRef: `${sourcePath}#L${lineIdx + 1}`,
                confidence: ProvenanceConfidence.VERIFIED
              })
            );
          }
        }
        yield { recordsDone, recordBytes };
      }
    }

    return {
      workspaces: Array.from(workspacesByPath.values()),
      sessions: Array.from(sessionsById.values()),
      operations,
      malformedRecords
    };
  }
}

/**
 * The structure of one Codex rollout, kept while the file is unchanged (like transcriptCache):
 * per line the session ID, folder, time, title and the files a patch names. Both record shapes
 * are read: the flat one (`function_call` with `target_file`) and Codex's own, where
 * `session_meta` names the session and folder, `turn_context` the folder, and an `apply_patch`
 * call names its files on `*** Add File:` / `*** Update File:` / `*** Move to:` lines. Never
 * message text or patch contents.
 */
const rolloutCache = new Map();
const PATCH_FILE_LINE = /^\*\*\* (Add File|Update File|Move to): (.+)$/gm;

function patchTargets(text) {
  const out = [];
  if (typeof text !== 'string' || !text.includes('*** ')) return out;
  for (const m of text.matchAll(PATCH_FILE_LINE)) {
    out.push({ target: m[2].trim(), operationType: m[1] === 'Update File' ? 'PATCH' : 'WRITE' });
  }
  return out;
}

function rolloutRecordStructure(entry) {
  const payload = entry && typeof entry.payload === 'object' && entry.payload ? entry.payload : null;
  const rec = {
    sessionId: entry.session_id || (entry.type === 'session_meta' && payload?.id) || null,
    cwd: typeof entry.cwd === 'string' ? entry.cwd : typeof payload?.cwd === 'string' && (entry.type === 'session_meta' || entry.type === 'turn_context') ? payload.cwd : null,
    timestamp: entry.timestamp || payload?.timestamp || null,
    title: typeof entry.title === 'string' ? entry.title : null,
    ops: []
  };
  // The flat shape
  if (entry.type === 'function_call' || entry.type === 'tool_call') {
    const target = entry.target_file || entry.file_path || entry.path;
    if (target) {
      rec.ops.push({
        toolName: String(entry.name || entry.tool || 'apply_patch'),
        target,
        operationType: entry.action === 'create' ? 'WRITE' : 'PATCH'
      });
    }
  }
  // Codex's own shape: an apply_patch call, as a tool of its own or run through the shell
  if (entry.type === 'response_item' && payload && /function_call|custom_tool_call|local_shell_call/.test(String(payload.type))) {
    let text = '';
    if (typeof payload.input === 'string') text = payload.input;
    else if (typeof payload.arguments === 'string') {
      try {
        const args = JSON.parse(payload.arguments);
        text = [args.input, args.patch, ...(Array.isArray(args.command) ? args.command : [])].filter((v) => typeof v === 'string').join('\n');
      } catch {
        text = payload.arguments;
      }
    } else if (Array.isArray(payload.action?.command)) {
      text = payload.action.command.filter((v) => typeof v === 'string').join('\n');
    }
    for (const t of patchTargets(text)) {
      rec.ops.push({ toolName: String(payload.name || 'apply_patch'), ...t });
    }
  }
  return rec;
}

export function readRolloutStructure(rolloutPath) {
  const st = fs.lstatSync(rolloutPath, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return null;
  const cached = rolloutCache.get(rolloutPath);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached;
  let content;
  try {
    content = fs.readFileSync(rolloutPath, 'utf8');
  } catch {
    return null;
  }
  const records = [];
  const malformed = [];
  let fileSessionId = null;
  let lineIdx = -1;
  let from = 0;
  while (from <= content.length) {
    let to = content.indexOf('\n', from);
    if (to === -1) to = content.length;
    lineIdx += 1;
    const line = content.slice(from, to).trim();
    from = to + 1;
    if (!line) continue;
    // A large line that is not a session record or a tool call is a model reply or a tool's
    // output: nothing on it is read, so it is not parsed
    if (line.length > 65536 && !/"(session_meta|function_call|custom_tool_call|local_shell_call|tool_call)"/.test(line)) continue;
    try {
      const rec = rolloutRecordStructure(JSON.parse(line));
      if (!fileSessionId && rec.sessionId) fileSessionId = String(rec.sessionId);
      records.push({ lineIdx, rec });
    } catch (err) {
      malformed.push({ sourcePath: rolloutPath, lineNumber: lineIdx + 1, error: err.message });
    }
  }
  const result = {
    size: st.size,
    mtimeMs: st.mtimeMs,
    bytes: content.length,
    // Lines that name no session belong to the session the rollout's first record names
    fileSessionId: fileSessionId || path.basename(rolloutPath, '.jsonl'),
    records,
    malformed
  };
  rolloutCache.set(rolloutPath, result);
  if (rolloutCache.size > 20000) rolloutCache.delete(rolloutCache.keys().next().value);
  return result;
}

/**
 * 4. Generic macOS Application Adapter (Fallback for any .app bundle)
 */
export class GenericMacOSAppAdapter {
  constructor() {
    this.id = 'generic-macos-app';
    this.displayName = 'Generic macOS Application';
    this.isSpecializedAIAdapter = false;
  }

  matches() {
    return true;
  }

  getCandidateDataDirectories({ name, bundleId, platformServices }) {
    if (platformServices.isWindowsLayout) {
      return platformServices.getStandardWindowsLocations({ appName: name });
    }
    return platformServices.getStandardMacOSLocations({
      bundleId,
      appName: name
    });
  }

  parseProvenanceRecords() {
    // Generic macOS apps have no validated conversation transcript schema;
    // application-level attribution is preserved, session provenance remains honestly UNKNOWN.
    return {
      workspaces: [],
      sessions: [],
      operations: [],
      malformedRecords: []
    };
  }
}

export class AdapterRegistry {
  constructor() {
    this.specializedAdapters = [
      new ClaudeCodeAdapter(),
      new CursorAdapter(),
      new CodexAdapter()
    ];
    this.fallbackAdapter = new GenericMacOSAppAdapter();
  }

  resolveAdapterForApp(appIdentity) {
    for (const adapter of this.specializedAdapters) {
      if (adapter.matches(appIdentity)) {
        return adapter;
      }
    }
    return this.fallbackAdapter;
  }

  getAdapterById(adapterId) {
    return (
      this.specializedAdapters.find((a) => a.id === adapterId) ||
      this.fallbackAdapter
    );
  }

  listAdapters() {
    return [...this.specializedAdapters, this.fallbackAdapter];
  }
}

function epochMsToIso(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

/**
 * Reads the composer (chat session) index from a Cursor workspace `state.vscdb` SQLite file.
 * The database is opened strictly read-only and only the `composer.composerData` key is read.
 * Any failure (locked database, unknown schema) is reported as a malformed record, never thrown.
 */
export function readCursorComposerIndex(stateDbPath, malformedRecords = []) {
  let db = null;
  try {
    db = new DatabaseSync(stateDbPath, { readOnly: true });
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
      .get();
    if (!row || row.value == null) {
      return [];
    }
    const parsed = JSON.parse(
      typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8')
    );
    const all = Array.isArray(parsed.allComposers) ? parsed.allComposers : [];
    return all
      .filter((c) => c && typeof c.composerId === 'string' && c.composerId)
      .map((c) => ({
        composerId: c.composerId,
        createdAt: epochMsToIso(c.createdAt),
        updatedAt: epochMsToIso(c.lastUpdatedAt)
      }));
  } catch (err) {
    malformedRecords.push({
      sourcePath: stateDbPath,
      lineNumber: 1,
      error: `Could not read Cursor composer index (${err.code || 'unreadable or unknown schema'})`
    });
    return [];
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // Ignore
      }
    }
  }
}
