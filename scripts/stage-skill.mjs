#!/usr/bin/env node
// Stage a clean copy of the hw-topo skill into ./skills for npm distribution.
//
// `prepare` entry point: a `dsh plugin add github:...` install runs it, and
// the cordis patch resolves the Skill root from `<installed package>/skills`.
// Walks the directory instead of `git ls-files` so source checkouts without
// git metadata (and npm pack from any host) stage identically.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const src = path.join(repoRoot, 'hw-topo');
const stageRoot = path.join(repoRoot, 'skills', 'hw-topo');

// `examples/fixture` ships (doctor/demo depend on it); `examples/out` and
// other generated artifacts stay behind.
const EXCLUDE_DIRS = new Set(['node_modules', 'test', 'out']);
const EXCLUDE_FILES = new Set(['package-lock.json', '.DS_Store']);

function listFiles(dir, prefix, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      listFiles(path.join(dir, entry.name), rel, out);
    } else if (!EXCLUDE_FILES.has(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

fs.rmSync(path.join(repoRoot, 'skills'), { recursive: true, force: true });
fs.mkdirSync(stageRoot, { recursive: true });
const files = listFiles(src, '', []);
for (const rel of files) {
  const from = path.join(src, rel);
  const to = path.join(stageRoot, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
// npm parses stdout as JSON during pack --json; keep chatter on stderr.
process.stderr.write(`staged skills/hw-topo (${files.length} files, clean)\n`);
