// Verify-gate tests: the anti-hallucination contract.
// - derived spec passes with risk 0
// - injected fake module / stale line / fake edge are each caught
// - disclosure moves items out of the risk numerator
// - deliver refuses unverified specs (unless explicitly allowed)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { scanRtl } from '../lib/scan-rtl.mjs';
import { deriveSpec, structuralDiagnostics } from '../lib/spec.mjs';
import { verifySpec } from '../lib/verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'examples', 'fixture', 'rtl');
const cli = path.resolve(here, '..', 'bin', 'hw-topo.mjs');

function runCli(args) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' }) };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function derivedSpecObject() {
  return deriveSpec(scanRtl(fixture), { title: 't', projectName: 'fixture' });
}

test('derived spec is structurally clean and verifies at risk 0', () => {
  const spec = derivedSpecObject();
  assert.equal(structuralDiagnostics(spec).filter((f) => f.severity === 'error').length, 0);
  const receipt = verifySpec(spec, { root: fixture });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.metrics.unbacked, 0);
  assert.equal(receipt.metrics.broken, 0);
  assert.equal(receipt.metrics.hallucinationRisk, 0);
  assert.ok(receipt.metrics.backed > 10);
});

test('invented module is flagged unbacked with a supported fix', () => {
  const spec = derivedSpecObject();
  spec.nodes.push({ id: 'n-dead000000', label: 'magic_dma', kind: 'module', file: 'hsb_top.v', line: 1 });
  const receipt = verifySpec(spec, { root: fixture });
  assert.equal(receipt.ok, false);
  assert.equal(receipt.metrics.unbacked, 1);
  const finding = receipt.findings.find((f) => f.code === 'node/unresolved');
  assert.ok(finding, 'node/unresolved finding present');
  assert.ok(finding.supportedFixes.length > 0);
});

test('wrong line number is broken and reports the true location', () => {
  const spec = derivedSpecObject();
  const node = spec.nodes.find((n) => n.label === 'port_bench');
  spec.nodes.push({ ...node, id: 'n-stale00000', line: 999 });
  const receipt = verifySpec(spec, { root: fixture });
  assert.equal(receipt.metrics.broken, 1);
  const finding = receipt.findings.find((f) => f.code === 'node/stale-pointer');
  assert.match(finding.message, /port_bench\.v:4/);
});

test('invented instance edge is flagged', () => {
  const spec = derivedSpecObject();
  const parent = spec.nodes.find((n) => n.label === 'clk_div');
  const child = spec.nodes.find((n) => n.label === 'dma_engine');
  spec.instances.push({ id: 'i-bogus00000', parent: parent.id, child: child.id, label: 'u_bogus', count: 1, file: 'hsb_top.v', line: 1 });
  const receipt = verifySpec(spec, { root: fixture });
  assert.equal(receipt.metrics.unbacked, 1);
  assert.ok(receipt.findings.some((f) => f.code === 'instance/unresolved'));
});

test('disclosure moves an unbacked node into the disclosed bucket', () => {
  const spec = derivedSpecObject();
  spec.nodes.push({ id: 'n-dead000000', label: 'future_blk', kind: 'module', file: 'hsb_top.v', line: 1 });
  spec.meta.disclosed_unverified = [{ id: 'n-dead000000', reason: 'planned, not yet written' }];
  const receipt = verifySpec(spec, { root: fixture });
  assert.equal(receipt.metrics.unbacked, 0);
  assert.equal(receipt.metrics.disclosed, 1);
  assert.equal(receipt.ok, true, 'disclosed items pass the gate visibly');
});

test('connection verification requires the signal on the evidence line', () => {
  const spec = derivedSpecObject();
  const from = spec.nodes.find((n) => n.label === 'hsb_top');
  const to = spec.nodes.find((n) => n.label === 'clk_div');
  const good = {
    id: 'c-good000000', from: from.id, to: to.id, signal: 'clk_i', kind: 'clock',
    file: 'hsb_top.v', line: 34, evidence: [{ file: 'hsb_top.v', line: 34, role: 'signal' }],
  };
  const bad = { ...good, id: 'c-bad0000000', signal: 'no_such_net_42' };
  spec.connections.push(good, bad);
  const receipt = verifySpec(spec, { root: fixture });
  const rows = new Map(receipt.rows.map((r) => [r.element, r.verdict]));
  assert.equal(rows.get('c-good000000'), 'backed');
  assert.equal(rows.get('c-bad0000000'), 'unbacked');
});

test('structural diagnostics catch shape errors', () => {
  const spec = derivedSpecObject();
  spec.nodes[0].kind = 'cyanberry';
  spec.instances.push({ id: 'i-x', parent: 'n-missing', child: spec.nodes[0].id, file: 'a.v', line: 1 });
  const errors = structuralDiagnostics(spec).filter((f) => f.severity === 'error');
  const codes = errors.map((e) => e.code);
  assert.ok(codes.includes('node/kind-invalid'));
  assert.ok(codes.includes('instance/parent-unknown'));
});

// The structural gate lives in the CLI (cmdVerify), not in verifySpec: the
// library measures evidence, the command decides pass/fail. They must agree
// with `deliver`, which already refuses a structurally broken spec.
test('a structurally invalid spec fails verify too, not only deliver', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-struct-'));
  const specFile = path.join(tmp, 'empty.topology.json');
  const spec = derivedSpecObject();
  // Exactly what `derive` writes for a scan that found nothing.
  spec.nodes = [];
  spec.instances = [];
  spec.connections = [];
  fs.writeFileSync(specFile, JSON.stringify(spec, null, 2));

  const result = runCli(['verify', specFile, '--root', fixture, '--json']);
  const receipt = JSON.parse(result.stdout);
  assert.equal(result.code, 1);
  assert.equal(receipt.ok, false);
  assert.ok(receipt.findings.some((f) => f.code === 'nodes/empty'), 'the finding names the real cause');
  // ...and the failure is NOT the evidence: nothing was unproven, there was
  // simply nothing to prove. Saying "risk 0%" while exiting 1 would be the
  // tool contradicting itself.
  assert.equal(receipt.metrics.unbacked, 0);
  assert.equal(receipt.metrics.broken, 0);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('producer caveats reach the receipt as warnings without failing the gate', () => {
  const spec = derivedSpecObject();
  const bundle = scanRtl(fixture);
  bundle.diagnostics = {
    parseErrors: 2,
    elaborated: false,
    outsideRootCount: 1,
    outsideRootFiles: ['../shared/globals.vh'],
  };
  const receipt = verifySpec(spec, { root: fixture, bundle });
  // Everything is still backed: a caveat is not a defect.
  assert.equal(receipt.ok, true);
  assert.equal(receipt.metrics.unbacked, 0);
  assert.equal(receipt.metrics.broken, 0);
  const codes = receipt.findings.map((f) => f.code);
  assert.ok(codes.includes('evidence/parse-errors'), 'parse errors must be visible');
  assert.ok(codes.includes('evidence/incomplete-coverage'), 'excluded files must be visible');
  assert.ok(receipt.findings.every((f) => f.severity === 'warning'));
  assert.match(receipt.findings.find((f) => f.code === 'evidence/incomplete-coverage').message, /覆盖不完整/);

  // A clean bundle says nothing extra.
  assert.equal(verifySpec(spec, { root: fixture, bundle: scanRtl(fixture) })
    .findings.some((f) => f.code.startsWith('evidence/')), false);
});

test('verify notices when the source moves (edit between derive and verify)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-'));
  fs.copyFileSync(path.join(fixture, 'hsb_top.v'), path.join(tmp, 'hsb_top.v'));
  const spec = deriveSpec(scanRtl(tmp), { title: 't', groupByDir: false });
  // Insert a comment at the top: every line pointer below shifts by 1.
  fs.writeFileSync(path.join(tmp, 'hsb_top.v'), `// shift\n${fs.readFileSync(path.join(tmp, 'hsb_top.v'), 'utf8')}`);
  const receipt = verifySpec(spec, { root: tmp });
  assert.equal(receipt.ok, false);
  assert.ok(receipt.metrics.broken >= 1, 'stale pointers detected after source edit');
  fs.rmSync(tmp, { recursive: true, force: true });
});
