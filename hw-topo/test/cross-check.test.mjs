// Cross-engine divergence disclosure: classification and reporting.
//
// The interesting property here is the DISCRIMINATION: a coverage difference
// (one engine sees a site the other cannot) must never be reported as a
// coordinate mismatch, because "the two engines disagree about line numbers" is
// the failure this whole integration exists to remove. These tests pin both
// directions of that judgement, plus the explanation classifier and its
// no-false-positive cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  diffEngines,
  runCrossCheck,
  rowsFromBundle,
  rowsFromEvidence,
  witnessFromBuiltin,
  generateBlockReason,
  deadIfdefReason,
  arrayedFormReason,
  CATEGORIES,
  CROSS_CHECK_SCHEMA,
} from '../lib/cross-check.mjs';

const F = 'top.v';

const instance = (parent, type, name, line1) => ({ parent, type, instance: name, file: F, line1 });
const module_ = (name, line1) => ({ name, file: F, line1 });

function engines(primary, secondary, extra = {}) {
  return diffEngines({
    primary: { backend: 'rtlens', modules: [], instances: [], ...primary },
    secondary: { backend: 'builtin', modules: [], instances: [], ...secondary },
    readSource: () => extra.source ?? null,
    defines: extra.defines ?? {},
    ...extra.diff,
  });
}

test('identical engines produce verdict "agree" and no divergences', () => {
  const rows = { modules: [module_('a', 1)], instances: [instance('a', 'b', 'u0', 5)] };
  const report = engines(rows, rows);
  assert.equal(report.verdict, 'agree');
  assert.deepEqual(report.divergences, []);
  assert.equal(report.counts.coordinateMismatches, 0);
  assert.equal(report.counts.modules.shared, 1);
  assert.equal(report.counts.instances.shared, 1);
  assert.equal(report.schema, CROSS_CHECK_SCHEMA);
});

test('same identity with disjoint line sets is a coordinate mismatch', () => {
  const report = engines(
    { instances: [instance('m', 't', 'u0', 139), instance('m', 't', 'u0', 151)] },
    { instances: [instance('m', 't', 'u0', 140), instance('m', 't', 'u0', 152)] },
  );
  assert.equal(report.verdict, 'coordinate-mismatch');
  assert.equal(report.counts.coordinateMismatches, 1);
  assert.equal(report.divergences[0].category, CATEGORIES.coordinateMismatch);
  assert.equal(report.divergences[0].reportedBy, 'both');
  assert.deepEqual(report.divergences[0].primaryLines, [139, 151]);
  assert.deepEqual(report.divergences[0].secondaryLines, [140, 152]);
  assert.ok(report.divergences[0].note.length > 20, 'a reviewer must be told what this means');
});

test('partial line overlap is a site-count difference, NOT a coordinate mismatch', () => {
  const report = engines(
    { instances: [instance('m', 't', 'u0', 397)] },
    { instances: [instance('m', 't', 'u0', 139), instance('m', 't', 'u0', 151), instance('m', 't', 'u0', 397)] },
  );
  assert.equal(report.counts.coordinateMismatches, 0);
  assert.notEqual(report.verdict, 'coordinate-mismatch');
  assert.equal(report.divergences.length, 1);
  assert.match(report.divergences[0].detail, /site count \(1 vs 3\)/);
});

test('a site inside an undefined `ifdef is explained as dead-ifdef', () => {
  const source = [
    'module top;',
    '`ifdef RISCV_FORMAL',
    '  formal_monitor u_mon (.clk(clk));',
    '`endif',
    'endmodule',
  ].join('\n');
  const report = engines(
    { instances: [] },
    { instances: [instance('top', 'formal_monitor', 'u_mon', 3)] },
    { source, defines: {} },
  );
  assert.equal(report.divergences.length, 1);
  assert.equal(report.divergences[0].category, CATEGORIES.deadIfdef);
  assert.equal(report.divergences[0].reportedBy, 'secondary');
  assert.match(report.divergences[0].detail, /RISCV_FORMAL/);
});

test('the SAME site is NOT called dead when its macro is defined', () => {
  const source = [
    'module top;',
    '`ifdef FPGA',
    '  dsp u_dsp (.clk(clk));',
    '`endif',
    'endmodule',
  ].join('\n');
  const report = engines(
    { instances: [instance('top', 'dsp', 'u_dsp', 3)] },
    { instances: [] },
    { source, defines: { FPGA: 1 } },
  );
  assert.equal(report.divergences.length, 1);
  assert.equal(report.divergences[0].category, CATEGORIES.coverageOnly);
  assert.equal(report.divergences[0].detail, null);
});

test('`elsif / `else branches are tracked, not just `ifdef', () => {
  const source = [
    '`ifdef A',
    '  a_impl u_a (.x(x));',
    '`else',
    '  b_impl u_b (.x(x));',
    '`endif',
  ].join('\n');
  // A is defined -> the `else branch (line 4) is dead, the `ifdef branch is not.
  const deadElse = deadIfdefReason(source, 4, { A: 1 });
  assert.deepEqual(deadElse, { macro: 'A' });
  assert.equal(deadIfdefReason(source, 2, { A: 1 }), null);
  // With A undefined the roles swap.
  assert.deepEqual(deadIfdefReason(source, 2, {}), { macro: 'A' });
  assert.equal(deadIfdefReason(source, 4, {}), null);
});

test('nested conditionals report the OUTERMOST inactive frame', () => {
  const source = [
    '`ifdef OUTER',
    '`ifdef INNER',
    '  x u_x (.a(a));',
    '`endif',
    '`endif',
  ].join('\n');
  assert.deepEqual(deadIfdefReason(source, 3, { OUTER: 1, INNER: 1 }), null);
  assert.deepEqual(deadIfdefReason(source, 3, { OUTER: 1 }), { macro: 'INNER' });
  assert.deepEqual(deadIfdefReason(source, 3, {}), { macro: 'OUTER' });
});

test('a site inside a genvar loop is explained as generate-block', () => {
  const source = [
    'module top;',
    '  for (genvar x = 0; x < 4; x++) begin : gen_x',
    '    prim_clock_gating cg_i (.clk_i(clk_i));',
    '  end',
    'endmodule',
  ].join('\n');
  const report = engines(
    { instances: [] },
    { instances: [instance('top', 'prim_clock_gating', 'cg_i', 3)] },
    { source },
  );
  assert.equal(report.divergences[0].category, CATEGORIES.generateBlock);
  assert.match(report.divergences[0].detail, /genvar loop at line 2/);
  // and it is not misreported as a coordinate problem
  assert.equal(report.counts.coordinateMismatches, 0);
});

test('generateBlockReason stops at endmodule (no leak across modules)', () => {
  const source = [
    'module a;',
    '  for (genvar i = 0; i < 2; i++) begin : g',
    '  end',
    'endmodule',
    'module b;',
    '  leaf u_leaf (.a(a));',
    'endmodule',
  ].join('\n');
  assert.deepEqual(generateBlockReason(source, 3), { line1: 2 });
  assert.equal(generateBlockReason(source, 6), null, 'line 6 is in module b, after endmodule');
});

test('arrayed instantiation forms are recognised', () => {
  assert.equal(arrayedFormReason('  SB_IO #(.PIN_TYPE(1)) io_inst [7:0] (.PACKAGE_PIN(p));', 1), true);
  assert.equal(arrayedFormReason('  foo bar[3:0] (.a(a));', 1), true);
  assert.equal(arrayedFormReason('  foo bar (.a(a));', 1), false);
  assert.equal(arrayedFormReason('  leaf u_leaf (.a(a));', 1), false);
});

test('an arrayed site only one engine reports is explained as arrayed-form', () => {
  const source = '  SB_IO #(.PIN_TYPE(1)) io_inst [7:0] (.PACKAGE_PIN(p));';
  const report = engines(
    { instances: [instance('top', 'SB_IO', 'io_inst', 1)] },
    { instances: [] },
    { source },
  );
  assert.equal(report.divergences[0].category, CATEGORIES.arrayedForm);
  assert.equal(report.divergences[0].reportedBy, 'primary');
});

test('module-level coverage differences are reported too', () => {
  const report = engines({ modules: [module_('a', 4)] }, { modules: [] });
  assert.equal(report.divergences.length, 1);
  assert.equal(report.divergences[0].kind, 'module');
  assert.equal(report.divergences[0].identity, `a|${F}`);
});

test('an unreadable file degrades to coverage-only instead of throwing', () => {
  const report = engines(
    { instances: [instance('m', 't', 'u0', 5)] },
    { instances: [] },
    { source: null },
  );
  assert.equal(report.divergences[0].category, CATEGORIES.coverageOnly);
});

test('divergences are capped and the cap is disclosed', () => {
  const left = { instances: [] };
  const right = { instances: [] };
  for (let i = 0; i < 5; i++) {
    left.instances.push(instance('m', 't', `u${i}`, i + 1));
  }
  const report = engines(left, right, { diff: { maxDivergences: 2 } });
  assert.equal(report.divergences.length, 2);
  assert.equal(report.truncated, true);
  assert.equal(report.counts.byCategory[CATEGORIES.coverageOnly], 2);
});

test('the diff is deterministic and puts coordinate mismatches first', () => {
  const bad = {
    instances: [instance('m', 'z', 'u9', 60), instance('m', 'z', 'u9', 61)],
  };
  const secondary = { instances: [instance('m', 'z', 'u9', 70), instance('m', 'z', 'u9', 71)] };
  const once = engines(bad, secondary);
  const twice = engines(bad, secondary);
  assert.deepEqual(once, twice);
  assert.equal(once.divergences[0].category, CATEGORIES.coordinateMismatch);
});

test('row normalisation reads both document shapes without inventing lines', () => {
  const bundle = {
    provenance: { backend: 'rtlens' },
    modules: [{ name: 'a', file: F, line: 4 }],
    instantiations: [{ parent: 'a', type: 'b', instance: 'u0', file: F, line: 5 }],
  };
  const rows = rowsFromBundle(bundle);
  assert.deepEqual(rows.modules[0], { name: 'a', file: F, line1: 4 });
  assert.deepEqual(rows.instances[0], { parent: 'a', type: 'b', instance: 'u0', file: F, line1: 5 });

  const evidence = {
    modules: [{ name: 'a', file: F, line0: 3, line1: 4 }],
    instances: [{ parent: 'a', type: 'b', instance: 'u0', file: F, line0: 4, line1: 5 }],
  };
  assert.deepEqual(rowsFromEvidence(evidence), {
    backend: 'rtlens',
    modules: [{ name: 'a', file: F, line1: 4 }],
    instances: [{ parent: 'a', type: 'b', instance: 'u0', file: F, line1: 5 }],
  });
});

test('runCrossCheck discloses an unavailable witness instead of failing', () => {
  const report = runCrossCheck('/nowhere', {
    primaryBundle: { provenance: { backend: 'rtlens' }, modules: [], instantiations: [] },
    primaryBackend: 'rtlens',
    secondary: { unavailable: true, reason: 'rtlens 6.1.2 is too old' },
  });
  assert.equal(report.checked, false);
  assert.equal(report.verdict, 'not-checked');
  assert.equal(report.secondary, null);
  assert.match(report.secondaryUnavailable, /too old/);
  assert.deepEqual(report.divergences, []);
});

test('runCrossCheck reads real source from disk to explain a divergence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-topo-xcheck-'));
  fs.writeFileSync(path.join(dir, 'top.v'), [
    'module top;',
    '`ifdef NEVER_DEFINED',
    '  phantom u_p (.a(a));',
    '`endif',
    'endmodule',
  ].join('\n'), 'utf8');

  const report = runCrossCheck(dir, {
    primaryBundle: {
      provenance: { backend: 'rtlens' },
      modules: [],
      instantiations: [],
    },
    primaryBackend: 'rtlens',
    secondary: witnessFromBuiltin({
      provenance: { backend: 'builtin' },
      modules: [],
      instantiations: [{ parent: 'top', type: 'phantom', instance: 'u_p', file: 'top.v', line: 3 }],
    }),
  });
  assert.equal(report.checked, true);
  assert.equal(report.primary, 'rtlens');
  assert.equal(report.secondary, 'builtin');
  assert.equal(report.divergences[0].category, CATEGORIES.deadIfdef);
});
