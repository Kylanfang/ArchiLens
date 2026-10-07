// Plugin packaging contract: staging layout + doctor + demo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const cli = path.join(repoRoot, 'hw-topo', 'bin', 'hw-topo.mjs');

function run(args, opts = {}) {
  return execFileSync(process.execPath, [args.cli ?? cli, ...args], { encoding: 'utf8', ...opts });
}

test('prepare stages a clean skills/hw-topo with the fixture and no tests/out', () => {
  execFileSync(process.execPath, [path.join(repoRoot, 'scripts', 'stage-skill.mjs')], { encoding: 'utf8' });
  const staged = path.join(repoRoot, 'skills', 'hw-topo');
  assert.ok(fs.existsSync(path.join(staged, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(staged, 'bin', 'hw-topo.mjs')));
  assert.ok(fs.existsSync(path.join(staged, 'examples', 'fixture', 'rtl', 'hsb_top.v')), 'fixture ships (doctor/demo need it)');
  assert.ok(!fs.existsSync(path.join(staged, 'test')), 'tests never ship');
  assert.ok(!fs.existsSync(path.join(staged, 'examples', 'out')), 'generated artifacts never ship');
});

test('doctor passes against the packaged fixture', () => {
  const report = JSON.parse(run(['doctor', '--json']));
  assert.equal(report.ok, true);
});

test('demo end-to-end produces the four artifacts with risk 0', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-demo-'));
  const out = JSON.parse(run(['demo', tmp, '--json']));
  assert.equal(out.ok, true);
  for (const f of ['demo.html', 'demo.svg', 'demo.wiki.md', 'demo.receipt.json']) {
    assert.ok(fs.existsSync(path.join(tmp, f)), f);
  }
  const receipt = JSON.parse(fs.readFileSync(path.join(tmp, 'demo.receipt.json'), 'utf8'));
  assert.equal(receipt.ok, true);
  assert.equal(receipt.metrics.hallucinationRisk, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('package manifest keeps the dsh bundle patch wiring', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(pkg.keywords.includes('dsh-plugin'));
  assert.ok(fs.existsSync(path.join(repoRoot, 'cordis.patch.yml')));
  const patch = fs.readFileSync(path.join(repoRoot, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /hw-topo-dsh\/package\.json/);
  assert.match(patch, /skills/);
});
