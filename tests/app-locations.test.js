import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArtifactAtlasService } from '../src/atlas-service.js';
import { createDeterministicDemoEnvironment } from '../src/fixtures/demo-environment.js';
import { claudeTempLocations } from '../src/discovery/claude-temp.js';
import { PlatformServices } from '../src/platform/platform-services.js';

function sandbox(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-locations-')));
  const services = [];
  const make = (opts) => {
    const s = new ArtifactAtlasService({ platform: 'darwin', ...opts });
    services.push(s);
    return s;
  };
  return Promise.resolve(fn(dir, make)).finally(() => {
    for (const s of services) s.sqliteStore.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

function write(file, text = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('LC1. Claude Code\'s temp folder: its own folders and logs only, linked to sessions by their ID', () =>
  sandbox(async (dir, make) => {
    const demo = createDeterministicDemoEnvironment(path.join(dir, 'demo'));
    const tmp = path.join(dir, 'tmp');
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const own = path.join(tmp, `claude-${uid}`);
    const output = path.join(own, '-Users-demo-Projects-neural-search-engine', 'sess_alpha_01', 'tasks', 'b1.output');
    write(output, 'command output');
    write(path.join(tmp, 'claude-code-123.diag.log'), 'diag');
    write(path.join(tmp, 'someone-else', 'file.txt'));
    write(path.join(tmp, 'claude-code.notes'));
    if (process.platform !== 'win32') {
      fs.symlinkSync(path.join(tmp, 'someone-else'), path.join(tmp, 'claude-9999'));
    }

    const ps = (liveHome) => new PlatformServices({ homeDir: demo.homeDir, platform: 'darwin', liveHome, tempBases: [tmp] });
    // Only for the live home: never for the sample or a folder named with --home
    assert.deepEqual(claudeTempLocations(ps(false)), []);
    const found = claudeTempLocations(ps(true)).map((l) => path.basename(l.path)).sort();
    assert.deepEqual(found, ['claude-code-123.diag.log', `claude-${uid}`].sort());

    const service = make({ homeDir: demo.homeDir, liveHome: true, tempBases: [tmp], env: {} });
    const state = await service.scanAndAnalyze({ bundlePath: 'atlas-known:claude' });
    const art = state.artifacts.find((a) => a.canonicalPath === output);
    assert.ok(art, 'the session\'s command output is found');
    const alpha = state.sessions.find((s) => s.externalSessionId === 'sess_alpha_01');
    assert.deepEqual(art.sessionIds, [alpha.id]);
    assert.ok(state.artifacts.some((a) => a.name === 'claude-code-123.diag.log'));
    assert.ok(!state.artifacts.some((a) => a.canonicalPath.includes('someone-else')), 'nothing else in the temp folder is read');
  }));

test('LC2. Moved folders (CLAUDE_CONFIG_DIR, CODEX_HOME): read in full, records stay records, never suggested', () =>
  sandbox(async (dir, make) => {
    const demo = createDeterministicDemoEnvironment(path.join(dir, 'demo'));
    const movedClaude = path.join(dir, 'elsewhere', 'claude-config');
    const movedCodex = path.join(dir, 'elsewhere', 'codex-home');
    fs.mkdirSync(path.dirname(movedClaude), { recursive: true });
    fs.renameSync(path.join(demo.homeDir, '.claude'), movedClaude);
    fs.renameSync(path.join(demo.homeDir, '.codex'), movedCodex);
    const env = { CLAUDE_CONFIG_DIR: movedClaude, CODEX_HOME: movedCodex };

    // Not the live home: the variables are ignored
    const ignored = make({ homeDir: demo.homeDir, env, liveHome: false, tempBases: [] });
    assert.equal((await ignored.scanAndAnalyze({ bundlePath: 'atlas-known:claude' })).sessions.length, 0);

    const service = make({ homeDir: demo.homeDir, env, liveHome: true, tempBases: [] });
    const state = await service.scanAndAnalyze({ bundlePath: 'atlas-known:claude' });
    assert.ok(state.sessions.length >= 2, 'sessions are read from the moved folder');
    const transcripts = state.artifacts.filter((a) => a.canonicalPath.startsWith(movedClaude) && a.extension === '.jsonl');
    assert.ok(transcripts.length >= 2);
    for (const t of transcripts) {
      assert.equal(t.artifactType, 'SESSION_HISTORY', t.canonicalPath);
      assert.notEqual(t.cleanupClassification, 'LOW');
    }
    const suggested = service.prepareSuggestedCleanup({
      groupIds: service.cleanupSuggestions({ now: Date.now() + 60 * 86400000 }).groups.map((g) => g.id),
      now: Date.now() + 60 * 86400000
    });
    const offered = new Set(service.pendingUnusedCleanup?.ids || []);
    assert.ok(transcripts.every((t) => !offered.has(t.id)), 'a moved transcript is never suggested');
    assert.ok(suggested.count >= 0);

    const codex = make({ homeDir: demo.homeDir, env, liveHome: true, tempBases: [] });
    const codexState = await codex.scanAndAnalyze({ bundlePath: 'atlas-known:codex' });
    assert.ok(codexState.sessions.length >= 1, 'Codex sessions are read from CODEX_HOME');

    // A variable naming a protected place or the home folder itself is not used
    const ps = new PlatformServices({ homeDir: demo.homeDir, liveHome: true, env: { CLAUDE_CONFIG_DIR: demo.homeDir, CODEX_HOME: 'relative/dir' } });
    assert.deepEqual(ps.appHomeOverrides(), {});
  }));

test('LC3. Archived Codex sessions are sessions; Codex and Cursor record stores are session records', () =>
  sandbox(async (dir, make) => {
    const demo = createDeterministicDemoEnvironment(path.join(dir, 'demo'));
    const codexHome = path.join(demo.homeDir, '.codex');
    fs.renameSync(path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions'));
    write(path.join(codexHome, 'state_5.sqlite'));
    write(path.join(codexHome, 'history.jsonl'), '{}\n');
    const service = make({ homeDir: demo.homeDir });
    const state = await service.scanAndAnalyze({ bundlePath: 'atlas-known:codex' });
    assert.ok(state.sessions.length >= 1, 'archived rollouts are read');
    for (const name of ['state_5.sqlite', 'history.jsonl']) {
      const a = state.artifacts.find((x) => x.name === name);
      assert.equal(a.artifactType, 'SESSION_HISTORY', name);
      assert.equal(a.cleanupClassification, 'HIGH', name);
    }

    const cursorTranscript = path.join(demo.homeDir, '.cursor', 'projects', 'my-app', 'agent-transcripts', 'c1.txt');
    const cursorGlobal = path.join(demo.homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    write(cursorTranscript, 'conversation text');
    write(cursorGlobal);
    const cursor = make({ homeDir: demo.homeDir });
    const cursorState = await cursor.scanAndAnalyze({ bundlePath: 'atlas-known:cursor' });
    for (const p of [cursorTranscript, cursorGlobal]) {
      const a = cursorState.artifacts.find((x) => x.canonicalPath === p);
      assert.equal(a.artifactType, 'SESSION_HISTORY', p);
      assert.equal(a.cleanupClassification, 'HIGH', p);
    }
  }));

test('LC4. Caches AI tools share: measured as a whole on request, links not followed, a hardlink once', () =>
  sandbox(async (dir) => {
    const { measureSharedCaches } = await import('../src/graph/shared-caches.js');
    const home = path.join(dir, 'home');
    const npx = path.join(home, '.npm', '_npx', 'abc123', 'node_modules', 'server', 'index.js');
    write(npx, 'x'.repeat(4096));
    write(path.join(home, '.cache', 'huggingface', 'hub', 'model.bin'), 'y'.repeat(8192));
    const outside = path.join(dir, 'outside', 'big.bin');
    write(outside, 'z'.repeat(65536));
    if (process.platform !== 'win32') {
      fs.symlinkSync(path.dirname(outside), path.join(home, '.npm', '_npx', 'link'));
      fs.linkSync(npx, path.join(home, '.npm', '_npx', 'abc123', 'copy.js'));
    }
    const ps = new PlatformServices({ homeDir: home, platform: 'darwin' });
    const { caches } = await measureSharedCaches(ps);
    const byName = Object.fromEntries(caches.map((c) => [c.name, c]));
    assert.deepEqual(Object.keys(byName).sort(), ['Hugging Face models', 'npx packages']);
    const n = byName['npx packages'];
    assert.equal(n.files, process.platform === 'win32' ? 1 : 2, 'the link to a folder outside is not followed');
    assert.ok(n.bytes >= 4096 && n.bytes < 65536, 'a hardlinked file counts once, the outside folder not at all');
    assert.ok(n.clearWith);
    // Nothing is listed file by file
    assert.ok(!('artifacts' in n) && !('paths' in n));
  }));
