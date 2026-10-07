// Security & robustness regression suite — every case here was a live probe
// during the deep stress test; each fix is pinned by an assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { scanRtl, maskCommentsAndStrings } from '../lib/scan-rtl.mjs';
import { structuralDiagnostics } from '../lib/spec.mjs';
import { verifySpec } from '../lib/verify.mjs';
import { layoutTopology } from '../lib/layout.mjs';
import { resolveInsideRoot } from '../lib/util.mjs';
import { extractTarGz } from '../lib/github.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '..', 'bin', 'hw-topo.mjs');
const fixture = path.resolve(here, '..', 'examples', 'fixture', 'rtl');
const corpus = path.resolve(here, 'corpus');

function run(args) {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

// ---- #1 evidence path containment -----------------------------------------
test('resolveInsideRoot rejects escapes and accepts clean relatives', () => {
  const root = path.resolve(fixture);
  assert.equal(resolveInsideRoot(root, 'hsb_top.v'), path.join(root, 'hsb_top.v'));
  assert.equal(resolveInsideRoot(root, '../hsb_top.v'), null);
  assert.equal(resolveInsideRoot(root, 'a/../../x.v'), null);
  assert.equal(resolveInsideRoot(root, 'C:\\evil.v'), null);
  assert.equal(resolveInsideRoot(root, '/abs.v'), null);
  assert.equal(resolveInsideRoot(root, 'a\\b.v'), null);
});

test('verify grades outside-root primitive evidence as broken, reads nothing', () => {
  const spec = {
    meta: { title: 't', project: { root: corpus }, disclosed_unverified: [] },
    nodes: [{ id: 'n-x', label: 'SB_GB_IO', kind: 'primitive', file: '../traps.v', line: 1 }],
    instances: [], connections: [], groups: [],
  };
  const r = verifySpec(spec, { root: corpus });
  assert.equal(r.metrics.broken, 1);
  assert.ok(r.findings.some((f) => f.code === 'node/file-missing'));
});

test('structural validation flags .. paths before any file IO', () => {
  const spec = {
    meta: { title: 't', project: { root: corpus }, disclosed_unverified: [] },
    nodes: [{ id: 'n-x', label: 'x', kind: 'module', file: '../../evil.v', line: 1 }],
    instances: [], connections: [], groups: [],
  };
  const codes = structuralDiagnostics(spec).map((f) => f.code);
  assert.ok(codes.includes('node/file-outside-root'));
});

test('collectSnippets cannot exfiltrate files outside the root (CVE-style probe)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-sec1-'));
  const specFile = path.join(tmp, 's.topology.json');
  run(['derive', fixture, '--out', specFile, '--json']);
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  spec.nodes[0].evidence = [{ file: '../../../package.json', line: 2, role: 'declaration' }];
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const receipt = JSON.parse(run(['deliver', specFile, '--allow-unverified', '--json']));
  const html = fs.readFileSync(receipt.artifacts.html.path, 'utf8');
  assert.ok(!html.includes('"name": "hw-topo"'), 'outside-root file content must not reach the HTML');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- #2 cyclic instantiation layout ---------------------------------------
test('mutual-instantiation cycle no longer stack-overflows', () => {
  const nodes = [
    { id: 'a', label: 'a', kind: 'module', file: 'x.v', line: 1 },
    { id: 'b', label: 'b', kind: 'module', file: 'x.v', line: 9 },
  ];
  const r = layoutTopology({
    meta: { title: 't', project: { root: '/x' }, disclosed_unverified: [] },
    nodes, connections: [], groups: [],
    instances: [
      { id: 'e1', parent: 'a', child: 'b', label: 'u', count: 1, file: 'x.v', line: 2 },
      { id: 'e2', parent: 'b', child: 'a', label: 'u', count: 1, file: 'x.v', line: 10 },
    ],
  });
  assert.equal(r.nodes.length, 2);
  assert.ok(r.width > 0 && r.height > 0);
});

// ---- #3 wiki markdown injection -------------------------------------------
test('crafted labels/titles cannot inject markdown or HTML into the wiki page', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-sec3-'));
  const specFile = path.join(tmp, 's.topology.json');
  run(['derive', fixture, '--out', specFile, '--json']);
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  spec.nodes[0].label = 'evil | col\n|---|---|\n| <img src=x onerror=alert(1)>';
  spec.meta.title = 'T | itle\nnewline: [x](javascript:alert(1))';
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const receipt = JSON.parse(run(['deliver', specFile, '--allow-unverified', '--json']));
  const md = fs.readFileSync(receipt.artifacts.wiki.path, 'utf8');
  assert.ok(!md.includes('<img src=x'), 'no raw HTML injection');
  assert.ok(!/\]\(javascript/.test(md), 'no active javascript: link');
  assert.ok(!md.split('\n').some((l) => l.includes('evil') && /(^|[^\\])\|---/.test(l)), 'payload line must not inject unescaped separators');
  assert.ok(/^title: "[^"\n]*"$/.test(md.split('\n')[1]), 'frontmatter title stays single-line quoted');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- #4 preprocessor directive masking ------------------------------------
test('`ifdef MACRO + task call no longer fuses into a fake instantiation', () => {
  const masked = maskCommentsAndStrings('`ifdef DEBUG_MAGIC\n  debug_task(addr);\n`endif\nmodule m;\nendmodule\n');
  assert.ok(!masked.includes('ifdef'));
  assert.ok(!masked.includes('DEBUG_MAGIC'));
  assert.ok(masked.includes('module m'));
  const bundle = scanRtl(corpus);
  assert.ok(!bundle.instantiations.some((i) => i.type === 'TRAP_MACRO'), 'corpus trap must stay inert');
  assert.ok(!bundle.instantiations.some((i) => i.instance === 'trap_task_call'));
});

test('directive masking preserves length and newlines', () => {
  const src = '``` `define X 1 ``` style lines:\n`define WIDTH 8\nwire w;\n`include "x.vh"\n';
  const masked = maskCommentsAndStrings(src);
  assert.equal(masked.length, src.length);
  assert.equal(masked.split('\n').length, src.split('\n').length);
  assert.ok(masked.includes('wire w;'));
});

// ---- #5 tar ADS colon --------------------------------------------------
test('tar members containing ":" are rejected (NTFS alternate data streams)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-sec5-'));
  const h = Buffer.alloc(512);
  h.write('repo/evil:ads.v', 0);
  h.write('000000644\0', 100);
  h.write('1'.padStart(11, '0') + '\0', 124);
  h.write('        ', 148);
  h.write('0', 156);
  const archive = zlib.gzipSync(Buffer.concat([h, Buffer.from('x'), Buffer.alloc(511), Buffer.alloc(1024)]));
  assert.throws(() => extractTarGz(archive, tmp), /escapes extraction root/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- #6 decompression bomb cap --------------------------------------------
test('gzip bomb is capped by maxOutputLength', () => {
  const bomb = zlib.gzipSync(Buffer.alloc(8 * 1024 * 1024)); // 8MB of zeros -> tiny gzip
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-sec6-'));
  assert.throws(() => extractTarGz(bomb, tmp, { maxOutputLength: 1024 * 1024 }), /buffer|output|memory|range/i);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- #7 scan walk early cap ------------------------------------------------
test('scanRtl enforces maxFiles during the walk', () => {
  assert.throws(() => scanRtl(corpus, { maxFiles: 2 }), /exceeds 2 files/);
});

// ---- #8 disclosure visibility ---------------------------------------------
test('all-disclosed spec passes the gate but the receipt shouts it', () => {
  const spec = {
    meta: {
      title: 't', project: { root: corpus },
      disclosed_unverified: [{ id: 'n1', reason: 'claimed planned' }],
    },
    nodes: [{ id: 'n1', label: 'phantom', kind: 'module', file: 'traps.v', line: 1 }],
    instances: [], connections: [], groups: [],
  };
  const r = verifySpec(spec, { root: corpus });
  assert.equal(r.ok, true);
  assert.equal(r.metrics.disclosed, 1);
  assert.ok(r.findings.some((f) => f.code === 'disclosure/used' && f.severity === 'warning'));
});

// ---- corpus behavior (traps stay inert) ------------------------------------
test('trap corpus: extraction set is exact', () => {
  const b = scanRtl(corpus);
  const names = new Set(b.modules.map((m) => m.name));
  for (const expected of ['good_top', 'legacy', 'my_bus', 'escaped', 'tiny', 'attr_mod', 'no_ports', 'trailing_c', 'prim_user', 'sv_mod', 'Leaf_CNTR', 'leaf', 'bom_mod', 'crlf_mod', 'longline_mod', 'broken_a', 'arr_top']) {
    assert.ok(names.has(expected), `module ${expected} missing`);
  }
  assert.ok(!names.has('pkg_t'), 'packages are not modules');
  assert.ok(!names.has('fake_in_comment'));
  assert.ok(!names.has('fake_in_block'));
  assert.ok(!names.has('fake_in_str'));
  assert.ok(!names.has('fake_in_unclosed'));
  // generate-block instance extracted once (textual truth)
  assert.ok(b.instantiations.some((i) => i.instance === 'u_gen'));
  // .* and positional connections
  assert.ok(b.instantiations.some((i) => i.instance === 'u_star'));
  assert.ok(b.instantiations.some((i) => i.instance === 'u_pos'));
  // array instantiation: under-reported by design, but never mis-reported
  assert.ok(!b.instantiations.some((i) => i.instance === 'u_arr'));
});
