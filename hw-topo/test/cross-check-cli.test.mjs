// Cross-check end-to-end, through the CLI.
//
// The point of these tests is the ISOLATION: the evidence gate and the strict
// cross-check must be able to disagree, and each must be able to fail on its
// own. A test that only showed "exit 1" could not tell you which gate fired, so
// every negative control here also asserts that the OTHER gate passed.
//
// The witness is the stand-in RTLens package, pointed at a coordinate-shifted
// evidence document — a realistic off-by-one, produced the way one actually
// happens rather than by hand-editing one assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { probeRtlens } from '../lib/rtlens-backend.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '..', 'bin', 'hw-topo.mjs');
const fixture = path.resolve(here, '..', 'examples', 'fixture', 'rtl');
const fixturePkg = path.resolve(here, 'fixtures', 'rtlens-pkg');
const baseEvidence = path.resolve(here, 'fixtures', 'rtlens-evidence.fixture.json');

const probe = probeRtlens({ pkgRoot: fixturePkg });
const skip = probe.available
  ? false
  : `stand-in rtlens package unusable here (needs python 3): ${probe.reason}`;

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-topo-xcheck-cli-'));

/** Shift every coordinate in the fixture evidence by `delta` lines. */
function shiftedEvidence(delta) {
  const doc = JSON.parse(fs.readFileSync(baseEvidence, 'utf8'));
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      if (/^(line0|line1|endLine0|endLine1)$/.test(key) && Number.isInteger(node[key])) node[key] += delta;
      else walk(node[key]);
    }
  };
  walk(doc);
  const file = path.join(workdir, `evidence-${delta}.json`);
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return file;
}

function runCli(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

/** scan -> derive, returning the spec path (builtin primary, stand-in witness). */
function chain(tag, evidencePath, extraFlags = []) {
  const bundle = path.join(workdir, `${tag}.bundle.json`);
  const spec = path.join(workdir, `${tag}.spec.json`);
  const env = { HW_TOPO_FIXTURE_RTLENS_EVIDENCE: evidencePath };
  const scan = runCli(
    ['scan', fixture, '--backend', 'builtin', '--rtlens-root', fixturePkg, '--out', bundle, ...extraFlags],
    env,
  );
  assert.equal(scan.code, 0, scan.stderr);
  const derive = runCli(['derive', bundle, '--out', spec]);
  assert.equal(derive.code, 0, derive.stderr);
  return { spec, bundle, env };
}

const sameEvidence = baseEvidence;
const offByOne = shiftedEvidence(-1);

test('scan --cross-check: two agreeing engines report agreement, not silence', { skip }, () => {
  const { bundle, env } = chain('agree', sameEvidence, ['--cross-check']);
  const report = JSON.parse(runCli(['scan', fixture, '--backend', 'builtin', '--rtlens-root', fixturePkg,
    '--cross-check', '--json'], env).stdout);
  assert.equal(report.crossCheck.checked, true);
  assert.equal(report.crossCheck.primary, 'builtin');
  assert.equal(report.crossCheck.secondary, 'rtlens');
  assert.equal(report.crossCheck.verdict, 'agree');
  assert.deepEqual(report.crossCheck.divergences, []);
  assert.ok(report.crossCheck.counts.modules.shared > 0, 'agreement must be about real facts');

  // and the report is persisted next to the facts it describes
  const onDisk = JSON.parse(fs.readFileSync(bundle, 'utf8'));
  assert.equal(onDisk.diagnostics.crossCheck.verdict, 'agree');
  assert.ok(onDisk.modules.length > 0, 'the bundle itself is untouched by the cross-check');
});

test('scan --cross-check: an off-by-one witness is reported as coordinate mismatches', { skip }, () => {
  const report = JSON.parse(runCli(['scan', fixture, '--backend', 'builtin', '--rtlens-root', fixturePkg,
    '--cross-check', '--json'], { HW_TOPO_FIXTURE_RTLENS_EVIDENCE: offByOne }).stdout);
  assert.equal(report.crossCheck.verdict, 'coordinate-mismatch');
  assert.ok(report.crossCheck.counts.coordinateMismatches >= 10);
  assert.equal(report.crossCheck.counts.coverageOnly, 0);
  const first = report.crossCheck.divergences[0];
  assert.equal(first.category, 'coordinate-mismatch');
  assert.equal(first.primaryLines.length, 1);
  assert.equal(first.secondaryLines[0], first.primaryLines[0] - 1, 'the shift is visible in the report');
  // scan is the producer, not the gate: it still succeeds.
  assert.equal(runCli(['scan', fixture, '--backend', 'builtin', '--rtlens-root', fixturePkg,
    '--cross-check-strict', '--json'], { HW_TOPO_FIXTURE_RTLENS_EVIDENCE: offByOne }).code, 0);
});

test('verify honours a spec-recorded STRICT policy and fails on a coordinate mismatch alone', { skip }, () => {
  const { spec, env } = chain('strict', offByOne, ['--cross-check-strict']);
  const recorded = JSON.parse(fs.readFileSync(spec, 'utf8'));
  assert.equal(recorded.meta.diagnostics.crossCheck.policy, 'strict');

  // No --cross-check on the verify line: the recorded strictness must be
  // re-checked, never trusted. --rtlens-root pins the WITNESS to the stand-in;
  // without it, auto-discovery would (correctly) pick up a real install.
  const result = runCli(['verify', spec, '--root', fixture, '--rtlens-root', fixturePkg, '--json'], env);
  assert.equal(result.code, 1, result.stderr);
  const receipt = JSON.parse(result.stdout);

  // THE ISOLATION: the evidence gate passed. Only the cross-check failed.
  assert.equal(receipt.metrics.unbacked, 0, 'the evidence gate must be clean in this scenario');
  assert.equal(receipt.metrics.broken, 0, 'the evidence gate must be clean in this scenario');
  assert.equal(receipt.metrics.backed, receipt.metrics.elements);
  assert.equal(receipt.ok, false, 'strict cross-check must fail the receipt');
  assert.equal(receipt.crossCheck.verdict, 'coordinate-mismatch');

  const findings = receipt.findings.filter((f) => f.code === 'crosscheck/coordinate-mismatch');
  assert.ok(findings.length > 0, 'the failure must be attributed to the cross-check');
  assert.equal(findings[0].severity, 'error');
  assert.deepEqual(findings[0].subject.identity.includes('|'), true);
});

test('verify with --cross-check (warn) discloses the same mismatch without gating', { skip }, () => {
  const { spec, env } = chain('warn', offByOne, ['--cross-check']);
  const result = runCli(['verify', spec, '--root', fixture, '--rtlens-root', fixturePkg, '--cross-check', '--json'], env);
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.ok, true, 'warn mode must not fail the gate');
  assert.equal(receipt.crossCheck.verdict, 'coordinate-mismatch');
  assert.ok(receipt.crossCheck.counts.coordinateMismatches > 0, 'but the mismatch must still be disclosed');
  assert.equal(receipt.findings.filter((f) => f.code.startsWith('crosscheck/')).length, 0);
});

test('a spec with no cross-check recorded does not silently grow one', { skip }, () => {
  const { spec } = chain('plain', sameEvidence, []);
  const result = runCli(['verify', spec, '--root', fixture, '--json'], {
    HW_TOPO_FIXTURE_RTLENS_EVIDENCE: sameEvidence,
  });
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.crossCheck, undefined, 'an opt-in diagnostic must stay opt-in');
});

test('strict + uncheckable witness fails, because unproven is not passed', { skip }, () => {
  const bundle = path.join(workdir, 'nowitness.bundle.json');
  const spec = path.join(workdir, 'nowitness.spec.json');
  // Point the rtlens root at nothing: the witness cannot run.
  assert.equal(runCli(['scan', fixture, '--backend', 'builtin', '--rtlens-root',
    path.join(workdir, 'no-such-rtlens'), '--cross-check-strict', '--out', bundle]).code, 0);
  assert.equal(runCli(['derive', bundle, '--out', spec]).code, 0);

  const result = runCli(['verify', spec, '--root', fixture, '--rtlens-root',
    path.join(workdir, 'no-such-rtlens'), '--json']);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.metrics.unbacked, 0, 'the evidence gate is clean here too');
  assert.equal(receipt.crossCheck.checked, false);
  assert.match(receipt.crossCheck.secondaryUnavailable, /no package\.json|not a usable/);
  assert.equal(receipt.ok, false);
  assert.ok(receipt.findings.some((f) => f.code === 'crosscheck/unavailable'));
});

test('warn mode with an uncheckable witness stays green but says so', { skip }, () => {
  const bundle = path.join(workdir, 'warn-nowitness.bundle.json');
  const spec = path.join(workdir, 'warn-nowitness.spec.json');
  const missing = path.join(workdir, 'no-such-rtlens-2');
  assert.equal(runCli(['scan', fixture, '--backend', 'builtin', '--rtlens-root', missing,
    '--cross-check', '--out', bundle]).code, 0);
  assert.equal(runCli(['derive', bundle, '--out', spec]).code, 0);

  // warn is opt-in at verify time too: ask for it, and it discloses without gating.
  const result = runCli(['verify', spec, '--root', fixture, '--rtlens-root', missing, '--cross-check', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.crossCheck.checked, false);
  assert.equal(receipt.crossCheck.verdict, 'not-checked');
  assert.ok(receipt.crossCheck.secondaryUnavailable.length > 10, 'the reason must be human-readable');
});
