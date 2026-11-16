#!/usr/bin/env node
// Runs `artifact-atlas leftovers` from the clone this skill lives in. Read only.
// Usage: node leftovers.mjs --app claude|codex|cursor --read-home [--session <id>] [--project <dir>] [--details] [--json]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Artifact Atlas needs Node.js 22.13 or newer (this is ${process.versions.node}).`);
  process.exit(1);
}

// The clone's root: the nearest folder above this script whose package.json is Artifact Atlas
let dir = path.dirname(fileURLToPath(import.meta.url));
let root = null;
for (;;) {
  try {
    if (JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name === 'artifact-atlas') {
      root = dir;
      break;
    }
  } catch {}
  const up = path.dirname(dir);
  if (up === dir) break;
  dir = up;
}
if (!root) {
  console.error('This skill runs from a clone of https://github.com/yazicmert/Artifacts-Atlas; its source was not found.');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  // Scans have no file limit: room for a few million files
  ['--no-warnings', '--max-old-space-size=8192', path.join(root, 'src', 'cli.js'), 'leftovers', ...process.argv.slice(2)],
  { stdio: 'inherit' }
);
process.exit(result.status ?? 1);
