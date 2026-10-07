// Deliver + wiki + viewer tests: the four-artifact contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '..', 'bin', 'hw-topo.mjs');
const fixture = path.resolve(here, '..', 'examples', 'fixture', 'rtl');

function run(args, opts = {}) {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...opts });
}

test('deliver produces html + svg + wiki + receipt with risk 0', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-deliver-'));
  const bundleFile = path.join(tmp, 'b.json');
  const specFile = path.join(tmp, 's.topology.json');
  run(['scan', fixture, '--out', bundleFile, '--json']);
  run(['derive', bundleFile, '--out', specFile, '--json']);
  const receipt = JSON.parse(run(['deliver', specFile, '--json']));
  assert.equal(receipt.ok, true);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.verify.metrics.hallucinationRisk, 0);
  for (const key of ['html', 'svg', 'wiki', 'receipt']) {
    assert.ok(receipt.artifacts[key].path, `artifact ${key} present`);
    assert.ok(fs.existsSync(receipt.artifacts[key].path), `artifact ${key} on disk`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('viewer html embeds evidence snippets and the index table data', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-html-'));
  const specFile = path.join(tmp, 's.topology.json');
  run(['derive', fixture, '--out', specFile, '--json']);
  run(['deliver', specFile, '--json']);
  const html = fs.readFileSync(path.join(tmp, 's.html'), 'utf8');
  assert.ok(html.includes('const INDEX ='));
  assert.ok(html.includes('hsb_top.v:34'), 'snippet line evidence embedded');
  assert.ok(html.includes('模块索引'), 'index table section present');
  assert.ok(html.includes('id="search"'));
  assert.ok(!html.includes('<script src='), 'no external scripts');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('standalone svg is valid xml with embedded style and defs', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-svg-'));
  const specFile = path.join(tmp, 's.topology.json');
  run(['derive', fixture, '--out', specFile, '--json']);
  run(['deliver', specFile, '--json']);
  const svg = fs.readFileSync(path.join(tmp, 's.svg'), 'utf8');
  assert.ok(svg.startsWith('<?xml'));
  assert.ok(svg.includes('<style>'));
  assert.ok(svg.includes('marker id="topo-arrow"'), 'arrow marker inside svg');
  assert.ok(svg.includes('hsb_top'), 'node labels rendered');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('wiki page is a codebase index with file:line links and receipt block', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-wiki-'));
  const specFile = path.join(tmp, 's.topology.json');
  run(['derive', fixture, '--out', specFile, '--json']);
  run(['deliver', specFile, '--json']);
  const md = fs.readFileSync(path.join(tmp, 's.wiki.md'), 'utf8');
  assert.ok(md.includes('# RTL 拓扑'));
  assert.ok(md.includes('## 模块索引'));
  assert.ok(md.includes('## 自检回执'));
  assert.match(md, /\(hsb_top\.v\)/, 'module row links to source file');
  assert.match(md, /hsb_top\.v:\d+/, 'file:line pointers present');
  assert.match(md, /幻觉风险/, 'risk metric surfaced');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('deliver blocks on unverified spec; --allow-unverified stamps a warning', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-block-'));
  const specFile = path.join(tmp, 's.topology.json');
  run(['derive', fixture, '--out', specFile, '--json']);
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  spec.nodes.push({ id: 'n-fake0000000', label: 'phantom', kind: 'module', file: 'hsb_top.v', line: 1 });
  fs.writeFileSync(specFile, JSON.stringify(spec));
  let blocked = false;
  try { run(['deliver', specFile, '--json']); } catch (e) { blocked = e.status === 1; }
  assert.ok(blocked, 'deliver exits 1 when verify fails');
  const receipt = JSON.parse(run(['deliver', specFile, '--allow-unverified', '--json']));
  assert.equal(receipt.ok, true);
  assert.equal(receipt.verified, false);
  const html = fs.readFileSync(receipt.artifacts.html.path, 'utf8');
  assert.ok(html.includes('未通过 verify 门禁'), 'warning banner stamped');
  fs.rmSync(tmp, { recursive: true, force: true });
});
