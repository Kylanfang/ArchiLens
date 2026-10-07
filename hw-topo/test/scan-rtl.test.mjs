// Scanner unit tests: extraction correctness on the HSB-style fixture,
// including the comment/string/macro traps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanRtl, maskCommentsAndStrings } from '../lib/scan-rtl.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'examples', 'fixture', 'rtl');

test('maskCommentsAndStrings preserves length and newlines', () => {
  const src = 'module a; // c1\n/* b\n c2 */ wire x = "not module b;";\n';
  const masked = maskCommentsAndStrings(src);
  assert.equal(masked.length, src.length);
  assert.equal(masked.split('\n').length, src.split('\n').length);
  assert.ok(!masked.includes('c1'));
  assert.ok(!masked.includes('not module'));
  assert.match(masked, /module a/);
});

test('fixture scan extracts exact module set with correct lines', () => {
  const bundle = scanRtl(fixture);
  const byName = new Map(bundle.modules.map((m) => [m.name, m]));
  for (const name of ['hsb_top', 'clk_div', 'port_bench', 'bench_lane', 'dma_engine', 'tb_hsb_top']) {
    assert.ok(byName.has(name), `module ${name} missing`);
  }
  assert.equal(byName.get('hsb_top').file, 'hsb_top.v');
  assert.equal(byName.get('hsb_top').line, 6);
  assert.equal(byName.get('port_bench').line, 4);
  assert.equal(byName.get('tb_hsb_top').line, 44);
});

test('instantiations include names, files, lines; fakes excluded', () => {
  const bundle = scanRtl(fixture);
  const inst = bundle.instantiations;
  const has = (parent, type, instance) =>
    inst.some((i) => i.parent === parent && i.type === type && i.instance === instance);
  assert.ok(has('hsb_top', 'clk_div', 'u_clk_div'));
  assert.ok(has('hsb_top', 'port_bench', 'u_bench_ch0'));
  assert.ok(has('hsb_top', 'port_bench', 'u_bench_ch1'));
  assert.ok(has('hsb_top', 'dma_engine', 'u_dma'));
  assert.ok(has('port_bench', 'bench_lane', 'u_lane'));
  assert.ok(has('port_bench', 'SB_IO', 'u_io'));
  assert.ok(has('tb_hsb_top', 'hsb_top', 'dut'));
  // The two traps live inside comments/strings and must never appear.
  assert.ok(!inst.some((i) => i.type === 'fake_module'));
  assert.ok(!inst.some((i) => i.type === 'also_fake'));
  assert.ok(!inst.some((i) => i.type === 'FIRMWARE_DEBUG_ADDR'));
  const bench0 = inst.find((i) => i.instance === 'u_bench_ch0');
  assert.equal(bench0.file, 'hsb_top.v');
  assert.equal(bench0.line, 34);
});

test('unresolved classification: vendor primitive vs unknown', () => {
  const bundle = scanRtl(fixture);
  assert.equal(bundle.stats.unresolvedVendor, 1);
  assert.equal(bundle.stats.unresolvedUnknown, 0);
  assert.equal(bundle.unresolved[0].type, 'SB_IO');
});

test('ports: ANSI directions and non-ANSI resolution', () => {
  const bundle = scanRtl(fixture);
  const byName = new Map(bundle.modules.map((m) => [m.name, m]));
  const top = byName.get('hsb_top');
  assert.equal(top.portCount, 6);
  const dirs = new Map(top.ports.map((p) => [p.name, p.direction]));
  assert.equal(dirs.get('clk_i'), 'input');
  assert.equal(dirs.get('bench_stat_o'), 'output');
  const tb = byName.get('tb_hsb_top');
  const tbDirs = new Map(tb.ports.map((p) => [p.name, p.direction]));
  assert.equal(tbDirs.get('clk'), 'input');
  assert.equal(tbDirs.get('done'), 'output');
});

test('macro-prefixed identifiers and task calls are not instantiations', async () => {
  // Regression for `ifdef MACRO followed by task_call(x);` — the macro name
  // must not fuse with the following call into a fake instantiation.
  const { scanMaskedFile } = await import('../lib/scan-rtl.mjs');
  const masked = maskCommentsAndStrings(
    '`ifdef DEBUG_MAGIC\n  debug_task(addr);\n`endif\nmodule real_one (a, b);\ninput a;\noutput b;\nendmodule\n',
  );
  const { instantiations } = scanMaskedFile(masked);
  assert.ok(!instantiations.some((i) => i.type === 'DEBUG_MAGIC'));
});
