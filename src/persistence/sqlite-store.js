import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  {
    version: 1,
    name: '001_initial_provenance_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS applications (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        name TEXT NOT NULL,
        bundle_id TEXT,
        bundle_path TEXT,
        executable_path TEXT,
        version TEXT,
        adapter_id TEXT NOT NULL,
        is_supported_ai_app INTEGER NOT NULL DEFAULT 0,
        recognition_status TEXT NOT NULL,
        developer_metadata_json TEXT,
        known_data_directories_json TEXT,
        discovered_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        name TEXT NOT NULL,
        canonical_path TEXT NOT NULL UNIQUE,
        application_ids_json TEXT,
        has_git_repository INTEGER NOT NULL DEFAULT 0,
        discovered_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        external_session_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        workspace_id TEXT,
        title TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT,
        source_path TEXT,
        adapter_id TEXT NOT NULL,
        operation_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        workspace_id TEXT,
        sequence INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        target_path TEXT,
        timestamp TEXT,
        source_record_ref TEXT,
        confidence TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scans (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        application_id TEXT,
        authorized_roots_json TEXT NOT NULL,
        scanned_locations_json TEXT NOT NULL,
        discovered_artifact_count INTEGER NOT NULL DEFAULT 0,
        total_logical_bytes INTEGER NOT NULL DEFAULT 0,
        total_physical_bytes INTEGER NOT NULL DEFAULT 0,
        deduplicated_hardlink_count INTEGER NOT NULL DEFAULT 0,
        permission_limitations_json TEXT,
        skipped_symlinks_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS artifact_groups (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        name TEXT NOT NULL,
        category_key TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        application_id TEXT,
        workspace_id TEXT,
        artifact_ids_json TEXT NOT NULL,
        total_bytes INTEGER NOT NULL DEFAULT 0,
        deduplicated_bytes INTEGER NOT NULL DEFAULT 0,
        risk_summary TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        name TEXT NOT NULL,
        canonical_path TEXT NOT NULL UNIQUE,
        parent_dir TEXT NOT NULL,
        extension TEXT,
        is_directory INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        physical_inode_key TEXT,
        hardlink_count INTEGER NOT NULL DEFAULT 1,
        mode INTEGER NOT NULL DEFAULT 0,
        created_at TEXT,
        modified_at TEXT,
        mtime_ms REAL NOT NULL DEFAULT 0,
        artifact_type TEXT NOT NULL,
        application_id TEXT,
        workspace_id TEXT,
        group_id TEXT,
        session_ids_json TEXT NOT NULL,
        operation_ids_json TEXT NOT NULL,
        provenance_confidence TEXT NOT NULL,
        cleanup_classification TEXT NOT NULL,
        cleanup_explanation TEXT,
        deletion_consequences TEXT,
        shared_dependency_indicators_json TEXT,
        scan_id TEXT,
        quarantined INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        subject_id TEXT NOT NULL,
        confidence TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_ref TEXT,
        rule_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        details_json TEXT,
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provenance_edges (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        confidence TEXT NOT NULL,
        evidence_ids_json TEXT,
        explanation TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_artifacts_canonical_path ON artifacts(canonical_path);
      CREATE INDEX IF NOT EXISTS idx_operations_target_path ON operations(target_path);
      CREATE INDEX IF NOT EXISTS idx_edges_source_target ON provenance_edges(source_id, target_id);
    `
  },
  {
    version: 2,
    name: '002_quarantine_and_cleanup_recommendations',
    sql: `
      CREATE TABLE IF NOT EXISTS cleanup_recommendations (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        artifact_id TEXT NOT NULL,
        risk_category TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        eligible_for_quarantine INTEGER NOT NULL,
        eligible_for_bulk_cleanup INTEGER NOT NULL,
        requires_explicit_high_risk_override INTEGER NOT NULL,
        reason TEXT NOT NULL,
        consequences TEXT NOT NULL,
        shared_dependency_indicators_json TEXT
      );

      CREATE TABLE IF NOT EXISTS quarantine_entries (
        id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        batch_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        artifact_name TEXT NOT NULL,
        original_path TEXT NOT NULL,
        quarantine_path TEXT NOT NULL,
        manifest_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        original_mode INTEGER NOT NULL,
        original_mtime_ms REAL NOT NULL,
        original_inode_key TEXT,
        sha256 TEXT,
        risk_category TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        provenance_confidence TEXT NOT NULL,
        reason TEXT,
        quarantined_at TEXT NOT NULL,
        restored_at TEXT,
        status TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_quarantine_status ON quarantine_entries(status);
    `
  },
  {
    version: 3,
    name: '003_scan_truncation_flag',
    sql: `
      ALTER TABLE scans ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE scans ADD COLUMN max_files_limit INTEGER;
    `
  },
  {
    version: 4,
    name: '004_quarantine_session_ids',
    // Session IDs only (JSON array); never conversation text
    sql: `
      ALTER TABLE quarantine_entries ADD COLUMN session_ids TEXT NOT NULL DEFAULT '[]';
    `
  },
  {
    version: 5,
    name: '005_quarantine_purged_at',
    sql: `
      ALTER TABLE quarantine_entries ADD COLUMN purged_at TEXT;
    `
  },
  {
    version: 6,
    name: '006_scan_history',
    // Numbers, IDs and worktree paths only (see src/graph/scan-history.js); never conversation text
    sql: `
      CREATE TABLE IF NOT EXISTS scan_history (
        scan_id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL,
        scanned_at TEXT NOT NULL,
        summary_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scan_history_app ON scan_history(application_id, scanned_at);
    `
  },
  {
    version: 7,
    name: '007_quarantine_schedule',
    sql: `
      ALTER TABLE quarantine_entries ADD COLUMN auto_purge_at TEXT;
      ALTER TABLE quarantine_entries ADD COLUMN scheduled_by TEXT;
      ALTER TABLE quarantine_entries ADD COLUMN needed_again_at TEXT;
    `
  },
  {
    // Evidence, provenance edges and cleanup recommendations are kept in memory for the scan
    // shown; nothing reads them back, and writing one row per file to each made a large scan
    // slow. Their old rows are dropped. The file index (artifacts) stays.
    version: 8,
    name: '008_drop_per_file_derived_rows',
    sql: `
      DELETE FROM evidence;
      DELETE FROM provenance_edges;
      DELETE FROM cleanup_recommendations;
    `
  }
];

function parseIdList(raw) {
  try {
    const list = JSON.parse(raw || '[]');
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function quarantineRowToEntry(r) {
  return {
      schemaVersion: r.schema_version,
      id: r.id,
      batchId: r.batch_id,
      artifactId: r.artifact_id,
      artifactName: r.artifact_name,
      originalPath: r.original_path,
      quarantinePath: r.quarantine_path,
      manifestPath: r.manifest_path,
      sizeBytes: r.size_bytes,
      originalMode: r.original_mode,
      originalMtimeMs: r.original_mtime_ms,
      originalInodeKey: r.original_inode_key,
      sha256: r.sha256,
      riskCategory: r.risk_category,
      artifactType: r.artifact_type,
      provenanceConfidence: r.provenance_confidence,
      reason: r.reason,
      quarantinedAt: r.quarantined_at,
      restoredAt: r.restored_at,
      purgedAt: r.purged_at || null,
      autoPurgeAt: r.auto_purge_at || null,
      scheduledBy: r.scheduled_by || null,
      neededAgainAt: r.needed_again_at || null,
      status: r.status,
      sessionIds: parseIdList(r.session_ids)
  };
}

export class SQLiteStore {
  constructor(dbPath = ':memory:') {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    // With WAL, NORMAL keeps the database consistent after a crash; only the last commit can be
    // lost, and every scan is written again by the next one. The Quarantine's safety rests on
    // its manifests on disk, not on this setting.
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.runMigrations();
  }

  runMigrations() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const appliedRows = this.db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all();
    const appliedVersions = new Set(appliedRows.map((r) => Number(r.version)));

    for (const migration of MIGRATIONS) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }
      this.db.exec('BEGIN TRANSACTION;');
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString());
        this.db.exec('COMMIT;');
      } catch (err) {
        this.db.exec('ROLLBACK;');
        throw err;
      }
    }
  }

  getAppliedMigrations() {
    return this.db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC').all();
  }

  /**
   * Persists a complete scan and provenance snapshot transactionally.
   * Zero raw conversation prompt/response text is ever persisted.
   */
  saveSnapshot({
    application = null,
    workspaces = [],
    sessions = [],
    operations = [],
    scan = null,
    artifacts = [],
    artifactGroups = [],
    evidence = [],
    provenanceEdges = [],
    recommendations = []
  }) {
    this.db.exec('BEGIN TRANSACTION;');
    try {
      if (application) {
        this.db
          .prepare(`
            INSERT OR REPLACE INTO applications (
              id, schema_version, name, bundle_id, bundle_path, executable_path,
              version, adapter_id, is_supported_ai_app, recognition_status,
              developer_metadata_json, known_data_directories_json, discovered_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            application.id,
            application.schemaVersion,
            application.name,
            application.bundleId,
            application.bundlePath,
            application.executablePath,
            application.version,
            application.adapterId,
            application.isSupportedAIApp ? 1 : 0,
            application.recognitionStatus,
            JSON.stringify(application.developerMetadata || {}),
            JSON.stringify(application.knownDataDirectories || []),
            application.discoveredAt
          );
      }

      const wsStmt = this.db.prepare(`
        INSERT OR REPLACE INTO workspaces (
          id, schema_version, name, canonical_path, application_ids_json,
          has_git_repository, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const ws of workspaces) {
        wsStmt.run(
          ws.id,
          ws.schemaVersion,
          ws.name,
          ws.canonicalPath,
          JSON.stringify(ws.applicationIds || []),
          ws.hasGitRepository ? 1 : 0,
          ws.discoveredAt
        );
      }

      const sessStmt = this.db.prepare(`
        INSERT OR REPLACE INTO sessions (
          id, schema_version, external_session_id, application_id, workspace_id,
          title, started_at, ended_at, source_path, adapter_id, operation_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const sess of sessions) {
        sessStmt.run(
          sess.id,
          sess.schemaVersion,
          sess.externalSessionId,
          sess.applicationId,
          sess.workspaceId,
          sess.title,
          sess.startedAt,
          sess.endedAt,
          sess.sourcePath,
          sess.adapterId,
          sess.operationCount
        );
      }

      const opStmt = this.db.prepare(`
        INSERT OR REPLACE INTO operations (
          id, schema_version, session_id, application_id, workspace_id,
          sequence, tool_name, operation_type, target_path, timestamp,
          source_record_ref, confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const op of operations) {
        opStmt.run(
          op.id,
          op.schemaVersion,
          op.sessionId,
          op.applicationId,
          op.workspaceId,
          op.sequence,
          op.toolName,
          op.operationType,
          op.targetPath,
          op.timestamp,
          op.sourceRecordRef,
          op.confidence
        );
      }

      if (scan) {
        this.db
          .prepare(`
            INSERT OR REPLACE INTO scans (
              id, schema_version, status, application_id, authorized_roots_json,
              scanned_locations_json, discovered_artifact_count, total_logical_bytes,
              total_physical_bytes, deduplicated_hardlink_count,
              permission_limitations_json, skipped_symlinks_json, started_at, completed_at,
              truncated, max_files_limit
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            scan.id,
            scan.schemaVersion,
            scan.status,
            scan.applicationId,
            JSON.stringify(scan.authorizedRoots || []),
            // A scan can walk a hundred thousand folders: the row keeps the first thousand
            JSON.stringify((scan.scannedLocations || []).slice(0, 1000)),
            scan.discoveredArtifactCount,
            scan.totalLogicalBytes,
            scan.totalPhysicalBytes,
            scan.deduplicatedHardlinkCount,
            JSON.stringify((scan.permissionLimitations || []).slice(0, 1000)),
            JSON.stringify((scan.skippedSymlinks || []).slice(0, 1000)),
            scan.startedAt,
            scan.completedAt,
            scan.truncated ? 1 : 0,
            scan.maxFilesLimit ?? null
          );
      }

      const grpStmt = this.db.prepare(`
        INSERT OR REPLACE INTO artifact_groups (
          id, schema_version, name, category_key, artifact_type, application_id,
          workspace_id, artifact_ids_json, total_bytes, deduplicated_bytes, risk_summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const grp of artifactGroups) {
        grpStmt.run(
          grp.id,
          grp.schemaVersion,
          grp.name,
          grp.categoryKey,
          grp.artifactType,
          grp.applicationId,
          grp.workspaceId,
          JSON.stringify(grp.artifactIds || []),
          grp.totalBytes,
          grp.deduplicatedBytes,
          grp.riskSummary
        );
      }

      // The file index (artifacts) is written afterwards, in pieces: saveArtifactIndex
      void artifacts;
      // Evidence, edges and recommendations stay in memory (see migration 8)
      void evidence;
      void provenanceEdges;
      void recommendations;


      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  /** Several entries in one transaction (emptying the Quarantine can touch thousands). */
  /**
   * The file index of one app's newest scan: its old rows go, then the new ones, written in
   * pieces of `chunk` rows, one transaction each, with a pause between them so the app answers
   * while a large scan's index is written. `isCurrent()` false stops it (a newer scan started).
   */
  async saveArtifactIndex(applicationId, artifacts, { chunk = 20000, isCurrent = () => true } = {}) {
    const artStmt = this.db.prepare(`
        INSERT OR REPLACE INTO artifacts (
          id, schema_version, name, canonical_path, parent_dir, extension,
          is_directory, size_bytes, physical_inode_key, hardlink_count, mode,
          created_at, modified_at, mtime_ms, artifact_type, application_id,
          workspace_id, group_id, session_ids_json, operation_ids_json,
          provenance_confidence, cleanup_classification, cleanup_explanation,
          deletion_consequences, shared_dependency_indicators_json, scan_id, quarantined
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    if (applicationId) this.db.prepare('DELETE FROM artifacts WHERE application_id = ?').run(applicationId);
    for (let i = 0; i < artifacts.length; i += chunk) {
      if (!isCurrent()) return false;
      this.db.exec('BEGIN TRANSACTION;');
      try {
        for (const art of artifacts.slice(i, i + chunk)) {
          artStmt.run(
            art.id,
            art.schemaVersion,
            art.name,
            art.canonicalPath,
            art.parentDir,
            art.extension,
            art.isDirectory ? 1 : 0,
            art.sizeBytes,
            art.physicalInodeKey,
            art.hardlinkCount,
            art.mode,
            art.createdAt,
            art.modifiedAt,
            art.mtimeMs,
            art.artifactType,
            art.applicationId,
            art.workspaceId,
            art.groupId,
            JSON.stringify(art.sessionIds || []),
            JSON.stringify(art.operationIds || []),
            art.provenanceConfidence,
            art.cleanupClassification,
            art.cleanupExplanation,
            art.deletionConsequences,
            JSON.stringify(art.sharedDependencyIndicators || []),
            art.scanId,
            art.quarantined ? 1 : 0
          );
        }
        this.db.exec('COMMIT;');
      } catch (err) {
        try {
          this.db.exec('ROLLBACK;');
        } catch {
          // Closed meanwhile
        }
        return false;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    return true;
  }

  saveQuarantineEntries(entries) {
    this.db.exec('BEGIN TRANSACTION;');
    try {
      for (const entry of entries) this.writeQuarantineEntry(entry);
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  saveQuarantineEntry(entry) {
    this.db.exec('BEGIN TRANSACTION;');
    try {
      this.writeQuarantineEntry(entry);
      this.db.exec('COMMIT;');
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  writeQuarantineEntry(entry) {
      this.db
        .prepare(`
          INSERT OR REPLACE INTO quarantine_entries (
            id, schema_version, batch_id, artifact_id, artifact_name,
            original_path, quarantine_path, manifest_path, size_bytes,
            original_mode, original_mtime_ms, original_inode_key, sha256,
            risk_category, artifact_type, provenance_confidence, reason,
            quarantined_at, restored_at, status, session_ids, purged_at,
            auto_purge_at, scheduled_by, needed_again_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          entry.id,
          entry.schemaVersion,
          entry.batchId,
          entry.artifactId,
          entry.artifactName,
          entry.originalPath,
          entry.quarantinePath,
          entry.manifestPath,
          entry.sizeBytes,
          entry.originalMode,
          entry.originalMtimeMs,
          entry.originalInodeKey,
          entry.sha256,
          entry.riskCategory,
          entry.artifactType,
          entry.provenanceConfidence,
          entry.reason,
          entry.quarantinedAt,
          entry.restoredAt,
          entry.status,
          JSON.stringify(Array.isArray(entry.sessionIds) ? entry.sessionIds : []),
          entry.purgedAt || null,
          entry.autoPurgeAt || null,
          entry.scheduledBy || null,
          entry.neededAgainAt || null
        );

      this.db
        .prepare('UPDATE artifacts SET quarantined = ? WHERE id = ?')
        // A file emptied from the Quarantine is gone, so it stays out of the scan as well
        .run(entry.status === 'QUARANTINED' || entry.status === 'PURGED' ? 1 : 0, entry.artifactId);
  }

  listQuarantineEntries(statusFilter = null) {
    const rows = statusFilter
      ? this.db
          .prepare('SELECT * FROM quarantine_entries WHERE status = ? ORDER BY quarantined_at DESC')
          .all(statusFilter)
      : this.db.prepare('SELECT * FROM quarantine_entries ORDER BY quarantined_at DESC').all();

    return rows.map(quarantineRowToEntry);
  }

  saveScanSummary(summary) {
    if (!summary.scanId || !summary.applicationId) return;
    this.db
      .prepare('INSERT OR REPLACE INTO scan_history (scan_id, application_id, scanned_at, summary_json) VALUES (?, ?, ?, ?)')
      .run(summary.scanId, summary.applicationId, summary.scannedAt, JSON.stringify(summary));
    // Keep the last 50 scans of each application
    this.db
      .prepare(
        'DELETE FROM scan_history WHERE application_id = ? AND scan_id NOT IN (SELECT scan_id FROM scan_history WHERE application_id = ? ORDER BY scanned_at DESC LIMIT 50)'
      )
      .run(summary.applicationId, summary.applicationId);
  }

  /** Summaries of earlier scans of an application, newest first. */
  listScanSummaries(applicationId, limit = 50) {
    return this.db
      .prepare('SELECT summary_json FROM scan_history WHERE application_id = ? ORDER BY scanned_at DESC LIMIT ?')
      .all(applicationId, limit)
      .map((r) => {
        try {
          return JSON.parse(r.summary_json);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  /**
   * What the Quarantine screen shows, worked out in SQL so a vault of a hundred thousand files
   * is never sent whole: totals, one row per scheduled cleanup, and the newest other entries.
   */
  quarantineOverview({ limit = 300 } = {}) {
    const one = (sql, ...args) => this.db.prepare(sql).get(...args) || {};
    const held = one("SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS b, MIN(quarantined_at) AS oldest FROM quarantine_entries WHERE status = 'QUARANTINED'");
    const purged = one("SELECT COUNT(*) AS n, COALESCE(SUM(size_bytes), 0) AS b FROM quarantine_entries WHERE status = 'PURGED'");
    const batches = this.db
      .prepare(
        `SELECT batch_id AS batchId, scheduled_by AS scheduledBy, COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes,
                MIN(quarantined_at) AS quarantinedAt, SUM(auto_purge_at IS NOT NULL) AS waitingCount,
                MIN(auto_purge_at) AS dueAt, SUM(needed_again_at IS NOT NULL) AS keptCount
           FROM quarantine_entries
          WHERE status = 'QUARANTINED' AND scheduled_by IS NOT NULL
          GROUP BY batch_id, scheduled_by
          ORDER BY quarantinedAt DESC`
      )
      .all();
    const otherWhere = "NOT (status = 'QUARANTINED' AND scheduled_by IS NOT NULL)";
    const otherCount = one(`SELECT COUNT(*) AS n FROM quarantine_entries WHERE ${otherWhere}`).n || 0;
    const entries = this.db
      .prepare(`SELECT * FROM quarantine_entries WHERE ${otherWhere} ORDER BY quarantined_at DESC LIMIT ?`)
      .all(limit)
      .map((r) => quarantineRowToEntry(r));
    return {
      heldCount: held.n || 0,
      heldBytes: held.b || 0,
      oldestHeldAt: held.oldest || null,
      purgedCount: purged.n || 0,
      purgedBytes: purged.b || 0,
      batches,
      entries,
      moreEntries: Math.max(0, otherCount - entries.length)
    };
  }

  /** Entries held with a deletion date or a cleanup kind: what the hourly check looks at. */
  listScheduledQuarantineEntries() {
    return this.db
      .prepare("SELECT * FROM quarantine_entries WHERE status = 'QUARANTINED' AND scheduled_by IS NOT NULL AND auto_purge_at IS NOT NULL AND needed_again_at IS NULL")
      .all()
      .map((r) => quarantineRowToEntry(r));
  }

  /** Only the ids, for checks over the whole vault. */
  listQuarantineEntryIds() {
    return this.db.prepare('SELECT id FROM quarantine_entries').all().map((r) => r.id);
  }

  getQuarantineEntryById(entryId) {
    const row = this.db.prepare('SELECT * FROM quarantine_entries WHERE id = ?').get(entryId);
    return row ? quarantineRowToEntry(row) : null;
  }

  close() {
    this.db.close();
  }
}
