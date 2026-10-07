// Off-by-one regression anchor for the RTLens <-> hw-topo boundary.
//
// 这不是普通单元测试，而是把"两个插件不兼容"这个 bug 永久钉死的锚点。
// This is the permanent regression anchor for the bug described in
// docs/EVIDENCE_CONTRACT.md §0 and §6:
//
//   RTLens reports 0-based lines + absolute Windows paths.
//   hw-topo spec/verify speak 1-based lines + root-relative POSIX paths.
//
// Dropping the adapter and pouring raw RTLens coordinates into a spec must
// make the anti-hallucination gate reject the whole diagram:
//
//   elements 13 · backed 0 · broken 13 · hallucinationRisk 1.0 · exit 1
//
// If this test ever passes while claiming `ok: true`, the gate has been
// weakened and the two plugins are silently incompatible again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanRtl } from '../lib/scan-rtl.mjs';
import { deriveSpec } from '../lib/spec.mjs';
import { verifySpec } from '../lib/verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'examples', 'fixture', 'rtl');

/** Every evidence coordinate in a derived spec: node/instance/connection lines. */
function collectCoordinates(spec) {
  const coords = [];
  for (const node of spec.nodes || []) coords.push({ holder: node, where: `node ${node.label}` });
  for (const edge of spec.instances || []) coords.push({ holder: edge, where: `instance ${edge.label}`, endKeys: [] });
  for (const conn of spec.connections || []) coords.push({ holder: conn, where: `connection ${conn.signal}` });
  for (const group of spec.groups || []) {
    if (Number.isInteger(group.line) && group.line > 0) coords.push({ holder: group, where: `group ${group.label}` });
  }
  return coords;
}

test('baseline: builtin scan -> derive -> verify is green at risk 0', () => {
  const bundle = scanRtl(fixture);
  const spec = deriveSpec(bundle, { title: 'off-by-one baseline', projectName: 'fixture' });
  const receipt = verifySpec(spec, { root: fixture });
  assert.equal(receipt.ok, true, 'baseline must pass before the negative case is meaningful');
  assert.equal(receipt.metrics.unbacked, 0);
  assert.equal(receipt.metrics.broken, 0);
  assert.equal(receipt.metrics.hallucinationRisk, 0);
});

test('raw RTLens coordinates (line-1 + absolute Windows path) must be rejected', () => {
  const bundle = scanRtl(fixture);
  const spec = deriveSpec(bundle, { title: 'raw rtlens coordinates', projectName: 'fixture' });

  // Simulate "no adapter": every 1-based line becomes 0-based, and every
  // root-relative POSIX path becomes an absolute Windows path — i.e. exactly
  // what RTLens emits natively (contract R1 + R2).
  const winRoot = 'C:\\build\\archify-dsh\\hw-topo\\examples\\fixture\\rtl';
  const toAbsoluteWindows = (rel) => `${winRoot}\\${rel.split('/').join('\\')}`;
  let shifted = 0;
  for (const { holder } of collectCoordinates(spec)) {
    if (Number.isInteger(holder.line)) { holder.line -= 1; shifted++; }
    if (Number.isInteger(holder.endLine)) holder.endLine -= 1;
    if (typeof holder.file === 'string' && holder.file) holder.file = toAbsoluteWindows(holder.file);
    for (const ev of holder.evidence || []) {
      if (Number.isInteger(ev.line)) ev.line -= 1;
      if (typeof ev.file === 'string' && ev.file) ev.file = toAbsoluteWindows(ev.file);
    }
  }
  assert.ok(shifted > 0, 'the negative case must actually shift coordinates');

  const receipt = verifySpec(spec, { root: fixture });

  // The contract §6 numbers, verbatim.
  assert.equal(receipt.metrics.elements, 13, 'element count (10 nodes + 2 instance edges + 1 group)');
  assert.equal(receipt.metrics.backed, 0, 'not a single raw-coordinate element may resolve');
  assert.equal(receipt.metrics.broken, 13, 'every element is broken, not merely unbacked');
  assert.equal(receipt.metrics.hallucinationRisk, 1);
  assert.equal(receipt.ok, false, 'exit code 1: the gate must refuse to deliver');

  // The failure must be a *stale pointer* (the shape of an off-by-one), and it
  // must tell the truth about where the declaration really is — 1-based.
  const staleNodes = receipt.findings.filter((f) => f.code === 'node/stale-pointer');
  const staleEdges = receipt.findings.filter((f) => f.code === 'instance/stale-pointer');
  assert.equal(staleNodes.length, 6, 'all six module declarations must be reported stale');
  assert.equal(staleEdges.length, 6, 'the six resolvable instance sites must be reported stale');
  assert.ok(
    staleNodes.some((f) => /port_bench\.v:4/.test(f.message)),
    'the finding must point at the real 1-based location',
  );
  // Paths outside the root are rejected by containment, not "found": the
  // unresolved-primitive node has no name-based fallback, so it can only be
  // reported as a missing file.
  assert.ok(
    receipt.findings.some((f) => f.code === 'node/file-missing' && /SB_IO/.test(f.message)),
    'absolute Windows paths must be rejected by resolveInsideRoot',
  );
});
