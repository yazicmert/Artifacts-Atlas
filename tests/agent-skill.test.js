import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeterministicDemoEnvironment } from '../src/fixtures/demo-environment.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Codex and Cursor read .agents/skills, Claude Code reads .claude/skills; the copies must match
const SKILL_COPIES = [path.join(ROOT, '.agents', 'skills', 'artifact-atlas'), path.join(ROOT, '.claude', 'skills', 'artifact-atlas')];

function listFiles(dir, base = dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? listFiles(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))]))
    .sort();
}

function run(args, env = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CLAUDECODE: '', ...env }
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function withDemo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-skill-'));
  try {
    return fn(createDeterministicDemoEnvironment(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('SK1: the skill is the same in every folder the agents read, with a name and a description', () => {
  const [canonical, ...copies] = SKILL_COPIES;
  const files = listFiles(canonical);
  assert.deepEqual(files, ['SKILL.md', path.join('scripts', 'leftovers.mjs')]);
  for (const copy of copies) {
    assert.deepEqual(listFiles(copy), files, `${copy} has different files`);
    for (const f of files) {
      assert.equal(fs.readFileSync(path.join(copy, f), 'utf8'), fs.readFileSync(path.join(canonical, f), 'utf8'), `${copy}/${f} differs`);
    }
  }
  const skill = fs.readFileSync(path.join(canonical, 'SKILL.md'), 'utf8');
  const front = skill.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(front, 'SKILL.md starts with front matter');
  assert.match(front[1], /^name: artifact-atlas$/m);
  const description = front[1].match(/^description: (.+)$/m)?.[1] || '';
  assert.ok(description.length > 40 && description.length <= 1024, 'description fits the agents\' limit');
  // View only: the skill never cleans up for the user
  assert.doesNotMatch(skill, /--confirm|--allow-high-risk/);
});

test('SK2: the real home folder is read only with --read-home, and an unknown app is refused', () => {
  const refused = run(['--no-warnings', 'src/cli.js', 'leftovers', '--app', 'claude']);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /Ask the user first/);
  assert.equal(refused.out, '');
  // Naming the real home folder with --home still needs the yes
  const named = run(['--no-warnings', 'src/cli.js', 'leftovers', '--app', 'claude', '--home', os.homedir()]);
  assert.equal(named.code, 2);
  const unknown = run(['--no-warnings', 'src/cli.js', 'leftovers', '--app', 'notepad', '--read-home']);
  assert.equal(unknown.code, 1);
});

test('SK3: the summary has numbers by default, paths only with --details, and never prompt text', () => {
  withDemo((demo) => {
    const base = ['--no-warnings', 'src/cli.js', 'leftovers', '--app', 'claude', '--home', demo.homeDir, '--platform', 'darwin'];
    const plain = run(base);
    assert.equal(plain.code, 0, plain.err);
    assert.match(plain.out, /Artifact Atlas · Claude Code/);
    assert.match(plain.out, /Safe to remove/);
    assert.match(plain.out, /Nothing was moved or deleted/);
    assert.ok(!plain.out.includes(demo.homeDir), 'no paths without --details');
    assert.ok(!plain.out.includes('~/'), 'no paths without --details');

    const detailed = run([...base, '--details']);
    assert.equal(detailed.code, 0, detailed.err);
    assert.match(detailed.out, /Largest folders/);
    assert.match(detailed.out, /~[\\/]\.claude/);
    for (const out of [plain.out, detailed.out]) {
      assert.ok(!out.includes('Set up the core vector index'), 'no prompt text');
      assert.ok(!out.includes('Speed up vector search'), 'no prompt text');
    }

    const json = JSON.parse(run([...base, '--json']).out);
    assert.equal(json.scope, 'app');
    assert.equal(json.folders, null);
    assert.ok(json.total.count > 0);
    assert.equal(json.byRisk.map((r) => r.risk).join(','), 'LOW,REVIEW,HIGH,PROTECTED');
    assert.equal(json.scan.projectFoldersRead, false);
    assert.ok(json.sessions.length >= 2);

    // One session: found by the first characters of its own ID
    const one = JSON.parse(run([...base, '--json', '--session', json.sessions[0].id.slice(0, 10)]).out);
    assert.equal(one.scope, 'session');
    assert.equal(one.matchedSessions, 1);
    assert.ok(one.total.count > 0 && one.total.count < json.total.count);

    // A substitution the host left unfilled means the whole app
    const unfilled = JSON.parse(run([...base, '--json', '--session', '${CLAUDE_SESSION_ID}']).out);
    assert.equal(unfilled.scope, 'app');

    const emptied = JSON.parse(run([...base, '--session', '--json']).out);
    assert.equal(emptied.scope, 'app');

    const missing = run([...base, '--session', 'ffffffffffff']);
    assert.match(missing.out, /No session with that ID/);
  });
});

test('SK4: the skill runs the summary from its own folder and writes nothing to the home folder', () => {
  withDemo((demo) => {
    const before = listFiles(demo.homeDir);
    for (const copy of SKILL_COPIES) {
      const r = run([path.join(copy, 'scripts', 'leftovers.mjs'), '--app', 'claude', '--home', demo.homeDir, '--platform', 'darwin']);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /Artifact Atlas · Claude Code/);
      assert.doesNotMatch(r.err, /ExperimentalWarning/);
    }
    assert.deepEqual(listFiles(demo.homeDir), before);
  });
});
