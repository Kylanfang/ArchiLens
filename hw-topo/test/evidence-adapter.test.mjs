// Evidence-adapter tests: the RTLens -> hw-topo boundary.
//
// Two coordinate systems meet exactly here and nowhere else. These tests pin
// the transcription (contract §3), the off-by-one tripwire (R1), the path rule
// (R2), the schema drift guard (§5), and — most importantly — the equivalence
// anchor: the two independent implementations must report the SAME facts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evidenceToBundle, validateBundleShape, EVIDENCE_SCHEMA } from '../lib/evidence-adapter.mjs';
import { scanRtl } from '../lib/scan-rtl.mjs';
import { resolveBackend, probeRtlens } from '../lib/rtlens-backend.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'examples', 'fixture', 'rtl');
const evidenceFile = path.resolve(here, 'fixtures', 'rtlens-evidence.fixture.json');
const cli = path.resolve(here, '..', 'bin', 'hw-topo.mjs');
const fixturePkg = path.resolve(here, 'fixtures', 'rtlens-pkg');

/** Hand-built `rtlens.evidence/1` for our own fixture (values from RTLens). */
function fixtureEvidence() {
  const doc = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  // The committed document carries a machine-independent placeholder for the
  // absolute root (RTLens emits absolute paths, but a public fixture must not
  // leak a build machine's directory layout). Re-anchor it to this checkout so
  // the tests below still exercise real absolute coordinates.
  doc.root.abs = fixture;
  for (const f of doc.files || []) f.absPath = path.join(fixture, f.path);
  return doc;
}

/** Deep-clone-and-mutate a JSON document without touching the file on disk. */
function mutate(fn) {
  const doc = fixtureEvidence();
  fn(doc);
  return doc;
}

/** Canonical 1-based truth for the 6 modules (contract §0 table). */
const MODULE_TRUTH = {
  dma_engine: { file: 'dma_engine.v', line: 4, endLine: 41 },
  tb_hsb_top: { file: 'dma_engine.v', line: 44, endLine: 61 },
  hsb_top: { file: 'hsb_top.v', line: 6, endLine: 67 },
  clk_div: { file: 'hsb_top.v', line: 69, endLine: 80 },
  port_bench: { file: 'port_bench.v', line: 4, endLine: 34 },
  bench_lane: { file: 'port_bench.v', line: 36, endLine: 50 },
};

const INSTANCE_TRUTH = [
  ['tb_hsb_top', 'hsb_top', 'dma_engine.v', 50],
  ['hsb_top', 'clk_div', 'hsb_top.v', 27],
  ['hsb_top', 'port_bench', 'hsb_top.v', 34],
  ['hsb_top', 'port_bench', 'hsb_top.v', 42],
  ['hsb_top', 'dma_engine', 'hsb_top.v', 51],
  ['port_bench', 'bench_lane', 'port_bench.v', 17],
  ['port_bench', 'SB_IO', 'port_bench.v', 26],
];

const isRelativePosix = (p) =>
  typeof p === 'string' && p.length > 0 && !p.includes('\\') && !p.startsWith('/') &&
  !/^[A-Za-z]:/.test(p) && !p.split('/').includes('..');

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

test('adapter: fixture evidence -> bundle counts and coordinates (contract §0/§3)', () => {
  const bundle = evidenceToBundle(fixtureEvidence());

  assert.equal(bundle.stats.files, 3);
  assert.equal(bundle.stats.modules, 6);
  assert.equal(bundle.stats.instantiations, 7);
  assert.equal(bundle.stats.unresolvedVendor, 1);
  assert.equal(bundle.stats.unresolvedUnknown, 0);
  assert.equal(bundle.modules.length, 6);
  assert.equal(bundle.instantiations.length, 7);
  assert.equal(bundle.unresolved.length, 1);

  // Every module: 1-based line equal to the RTLens truth, relative POSIX file.
  for (const mod of bundle.modules) {
    const truth = MODULE_TRUTH[mod.name];
    assert.ok(truth, `unexpected module ${mod.name}`);
    assert.equal(mod.file, truth.file, `${mod.name} file`);
    assert.equal(mod.line, truth.line, `${mod.name} line (1-based)`);
    assert.equal(mod.endLine, truth.endLine, `${mod.name} endLine`);
  }

  // Every instantiation: exact 1-based line.
  const got = bundle.instantiations.map((i) => [i.parent, i.type, i.file, i.line]);
  assert.deepEqual(
    got.slice().sort(),
    INSTANCE_TRUTH.slice().sort(),
    'instantiation coordinates must equal the RTLens truth, 1-based',
  );

  // Every file pointer is root-relative POSIX (contract R2).
  for (const p of [
    ...bundle.files.map((f) => f.path),
    ...bundle.modules.map((m) => m.file),
    ...bundle.instantiations.map((i) => i.file),
    ...bundle.unresolved.map((u) => u.file),
  ]) {
    assert.ok(isRelativePosix(p), `${p} must be root-relative POSIX`);
  }
  assert.equal(bundle.unresolved[0].type, 'SB_IO');
  assert.equal(bundle.unresolved[0].classification, 'vendor-primitive');

  // Provenance shape (contract §4).
  assert.equal(bundle.provenance.backend, 'rtlens');
  assert.equal(bundle.provenance.degraded, false);
  assert.equal(bundle.provenance.reason, null);
  assert.equal(bundle.provenance.evidenceSchema, EVIDENCE_SCHEMA);
  assert.equal(bundle.tool, 'rtlens-evidence-adapter (rtlens 6.2.0)');
  assert.equal(bundle.schemaId, 'hw-topo.bundle/1');
  assert.equal(bundle.scannedAt, '2026-10-06T03:36:04.483Z', 'scannedAt comes from generatedAt');
  assert.equal(bundle.provenance.instantiationSource, 'instances[]');
  assert.equal(bundle.provenance.roleFallbacks, 0, 'upstream role is present, no fallback needed');

  assert.deepEqual(validateBundleShape(bundle), [], 'adapter output must satisfy its own shape check');
});

test('adapter: the producer\'s diagnostics survive the seam, whitelisted', () => {
  const clean = evidenceToBundle(fixtureEvidence());
  // The fixture carries a diagnostics block; it must not be dropped.
  assert.equal(typeof clean.diagnostics, 'object');
  assert.equal(clean.diagnostics.parseErrors, 0);
  assert.equal(clean.diagnostics.elaborated, false);

  const dirty = evidenceToBundle(mutate((doc) => {
    doc.diagnostics = {
      parseErrors: 3,
      elaborated: false,
      signalsTruncatedModules: 2,
      connectionsTruncatedInstances: 1,
      outsideRootFiles: ['../shared/globals.vh'],
      outsideRootCount: 1,
      somethingUpstreamInventedLater: 'must not be forwarded',
    };
  }));
  assert.equal(dirty.diagnostics.parseErrors, 3);
  assert.equal(dirty.diagnostics.signalsTruncatedModules, 2);
  assert.equal(dirty.diagnostics.connectionsTruncatedInstances, 1);
  assert.equal(dirty.diagnostics.outsideRootCount, 1);
  assert.deepEqual(dirty.diagnostics.outsideRootFiles, ['../shared/globals.vh']);
  assert.equal(dirty.diagnostics.somethingUpstreamInventedLater, undefined,
    'an unknown upstream field must not leak into the bundle contract');

  // No diagnostics upstream -> no diagnostics key here ("absent" is not "zero").
  assert.equal(evidenceToBundle(mutate((doc) => { delete doc.diagnostics; })).diagnostics, undefined);
});

test('adapter: ports/params are transcribed as name arrays, roles pass through', () => {
  const bundle = evidenceToBundle(fixtureEvidence());
  const byName = new Map(bundle.modules.map((m) => [m.name, m]));

  assert.deepEqual(byName.get('dma_engine').ports, ['clk_i', 'rst_ni', 'wdata_o', 'addr_o', 'valid_o', 'ready_i', 'error_o']);
  assert.deepEqual(byName.get('hsb_top').params, ['ADDR_W', 'DATA_W']);
  assert.deepEqual(byName.get('port_bench').params, ['CHANNELS']);
  assert.equal(byName.get('hsb_top').portCount, 6);
  assert.equal(byName.get('tb_hsb_top').role, 'top');
  assert.equal(byName.get('hsb_top').role, 'leaf-or-mid');
});

test('adapter: role falls back to "instantiated?" only when upstream omits it', () => {
  const doc = mutate((d) => { for (const mod of d.modules) delete mod.role; });
  const bundle = evidenceToBundle(doc);
  const byName = new Map(bundle.modules.map((m) => [m.name, m]));
  assert.equal(byName.get('tb_hsb_top').role, 'top', 'never instantiated -> top');
  assert.equal(byName.get('clk_div').role, 'leaf-or-mid', 'instantiated -> leaf-or-mid');
  assert.equal(bundle.provenance.roleFallbacks, 6, 'the fallback is recorded, not hidden');
});

test('adapter: modules[].instances[] is the documented fallback source', () => {
  const doc = mutate((d) => { delete d.instances; });
  const bundle = evidenceToBundle(doc);
  assert.equal(bundle.instantiations.length, 7);
  assert.equal(bundle.provenance.instantiationSource, 'modules[].instances[]');
  for (const inst of bundle.instantiations) {
    assert.ok(typeof inst.parent === 'string' && inst.parent, 'parent resolved from the declaring module');
  }
});

// ---------------------------------------------------------------------------
// negative tests: the tripwires that must never be relaxed
// ---------------------------------------------------------------------------

test('adapter rejects off-by-one: modules[0].line1 = line0 (contract R1)', () => {
  const doc = mutate((d) => { d.modules[0].line1 = d.modules[0].line0; });
  assert.throws(
    () => evidenceToBundle(doc),
    (error) => /line1 === line0 \+ 1/.test(error.message) && /dma_engine/.test(error.message),
    'the error must name the offending element and the invariant',
  );
});

test('adapter rejects a wholesale basis shift (every line1 decremented)', () => {
  const doc = mutate((d) => {
    for (const mod of d.modules) {
      mod.line1 -= 1;
      mod.endLine1 -= 1;
      for (const p of mod.ports || []) p.line1 -= 1;
    }
    for (const inst of d.instances) inst.line1 -= 1;
    for (const un of d.unresolved) un.line1 -= 1;
  });
  assert.throws(() => evidenceToBundle(doc), /off-by-one/);
});

test('adapter rejects off-by-one in an instantiation', () => {
  const doc = mutate((d) => { d.instances[3].line1 = d.instances[3].line0; });
  assert.throws(() => evidenceToBundle(doc), /instances\[3\].*line1 === line0 \+ 1/s);
});

test('adapter rejects off-by-one in endLine and in unresolved', () => {
  assert.throws(
    () => evidenceToBundle(mutate((d) => { d.modules[2].endLine1 = d.modules[2].endLine0 + 2; })),
    /endLine.*line1 === line0 \+ 1/s,
  );
  assert.throws(
    () => evidenceToBundle(mutate((d) => { d.unresolved[0].line1 += 1; })),
    /unresolved\[0\].*line1 === line0 \+ 1/s,
  );
});

test('adapter rejects a bare/incomplete coordinate (contract R4)', () => {
  assert.throws(
    () => evidenceToBundle(mutate((d) => { delete d.modules[1].line1; })),
    /missing integer line0\/line1/,
  );
});

test('adapter rejects a non-matching schema and reports what it saw (contract §5)', () => {
  assert.throws(
    () => evidenceToBundle(mutate((d) => { d.schema = 'rtlens.evidence/2'; })),
    (error) => /rtlens\.evidence\/2/.test(error.message) && /rtlens\.evidence\/1/.test(error.message),
  );
  assert.throws(() => evidenceToBundle({ schema: 'something/else' }), /something\/else/);
  assert.throws(() => evidenceToBundle(null), /must be a JSON object/);
});

test('adapter rejects path escapes: absolute, backslash, parent, drive letter (contract R2)', () => {
  for (const bad of ['D:\\abs\\x.v', '../x.v', 'a\\b.v', '/x.v', 'a/../../x.v']) {
    assert.throws(
      () => evidenceToBundle(mutate((d) => { d.modules[0].file = bad; })),
      /root-relative POSIX/,
      `${JSON.stringify(bad)} must be rejected`,
    );
  }
  assert.throws(
    () => evidenceToBundle(mutate((d) => { d.instances[0].file = 'C:\\proj\\hsb_top.v'; })),
    /root-relative POSIX/,
  );
  assert.throws(
    () => evidenceToBundle(mutate((d) => { d.unresolved[0].file = '..\\port_bench.v'; })),
    /root-relative POSIX/,
  );
  assert.throws(
    () => evidenceToBundle(mutate((d) => { d.files[0].path = 'D:\\proj\\dma_engine.v'; })),
    /root-relative POSIX/,
  );
});

test('adapter refuses to invent a classification it does not understand', () => {
  assert.throws(
    () => evidenceToBundle(mutate((d) => { d.unresolved[0].classification = 'maybe-vendor'; })),
    /classification/,
  );
});

// ---------------------------------------------------------------------------
// equivalence anchor: one fact set, two independent implementations
// ---------------------------------------------------------------------------

test('equivalence: adapter bundle === builtin scanRtl on the same tree', () => {
  const evidence = fixtureEvidence();
  // The loader re-anchors the committed document's placeholder root to the
  // bundled fixture tree, so absolute coordinates resolve inside this checkout.
  assert.equal(path.resolve(evidence.root.abs), path.resolve(fixture), 'evidence root must point at the bundled fixture');
  const scanned = scanRtl(fixture);
  const adapted = evidenceToBundle(evidence);

  const modules = (b) => b.modules.map((m) => `${m.name}|${m.file}|${m.line}|${m.endLine}`).sort();
  const instantiations = (b) => b.instantiations.map((i) => `${i.parent}|${i.type}|${i.file}|${i.line}`).sort();
  const unresolved = (b) => b.unresolved.map((u) => `${u.type}|${u.classification}`).sort();

  assert.deepEqual(modules(adapted), modules(scanned), 'module facts must be identical across the two implementations');
  assert.deepEqual(instantiations(adapted), instantiations(scanned), 'instantiation facts must be identical');
  assert.deepEqual(unresolved(adapted), unresolved(scanned), 'unresolved facts must be identical');
  assert.deepEqual(adapted.stats, scanned.stats, 'stats must be identical');

  // And the transcribed bundle must survive hw-topo's own shape check.
  assert.deepEqual(validateBundleShape(adapted), []);
});

test('validateBundleShape catches a wrong line basis and a stats mismatch', () => {
  const bundle = evidenceToBundle(fixtureEvidence());
  const shifted = JSON.parse(JSON.stringify(bundle));
  shifted.modules[0].line = 0;
  const findings = validateBundleShape(shifted);
  assert.ok(findings.some((f) => f.code === 'bundle/line-basis'));
  assert.ok(findings.some((f) => f.severity === 'error'));

  const lying = JSON.parse(JSON.stringify(bundle));
  lying.stats.modules = 99;
  assert.ok(validateBundleShape(lying).some((f) => f.code === 'bundle/stats-mismatch'));

  assert.equal(validateBundleShape(null).length, 1);
});

// ---------------------------------------------------------------------------
// backend resolution: degradation must be visible, forcing must be hard
// ---------------------------------------------------------------------------

test('resolveBackend(builtin) is degraded:true with a non-empty reason (R6)', () => {
  const { bundle, provenance } = resolveBackend(fixture, { backend: 'builtin' });
  assert.equal(provenance.backend, 'builtin');
  assert.equal(provenance.degraded, true);
  assert.ok(typeof provenance.reason === 'string' && provenance.reason.length > 0, 'degradation must carry a reason');
  assert.equal(provenance.evidenceSchema, null);
  assert.equal(bundle.provenance.backend, 'builtin');
  assert.deepEqual(validateBundleShape(bundle), []);
});

test('resolveBackend(rtlens) throws instead of degrading when unavailable', () => {
  const missing = path.join(here, 'fixtures', 'no-such-rtlens-install');
  const probe = probeRtlens({ pkgRoot: missing });
  assert.equal(probe.available, false);
  assert.match(probe.reason, /not a usable|not found|too old|python/);
  assert.throws(
    () => resolveBackend(fixture, { backend: 'rtlens', pkgRoot: missing }),
    /unavailable/,
    'forced rtlens must never silently fall back to the builtin scanner',
  );
});

test('an explicitly named rtlens root is authoritative and is never substituted', () => {
  // The machine running this suite may well have a perfectly good rtlens
  // installed somewhere (a DSH profile, a sibling node_modules). Naming a bad
  // root must STILL fail, and the error must name the root the caller asked
  // for — otherwise a typo in `--rtlens-root` silently indexes with some other
  // copy, which is the class of substitution this project refuses to make.
  const missing = path.join(here, 'fixtures', 'no-such-rtlens-install');
  const probe = probeRtlens({ pkgRoot: missing });
  assert.equal(probe.available, false, 'a named-but-broken root must not be replaced by a discovered one');
  assert.equal(probe.pkgRoot, path.resolve(missing), 'the reason must point at the requested root');
  assert.equal(probe.source, 'opts.pkgRoot');
  assert.ok(probe.reason.includes(path.resolve(missing)), `reason must name the requested root: ${probe.reason}`);

  // Auto-discovery, by contrast, is still allowed to look at other installs.
  const discovered = probeRtlens({});
  assert.notEqual(discovered.source, 'opts.pkgRoot');
});

test('resolveBackend rejects an unknown backend name', () => {
  assert.throws(() => resolveBackend(fixture, { backend: 'magic' }), /unknown backend/);
});

test('resolveBackend(--evidence) transcribes a saved document and records the file', () => {
  const { bundle, provenance, backend } = resolveBackend(fixture, { evidenceFile: evidenceFile });
  assert.equal(backend, 'rtlens');
  assert.equal(provenance.degraded, false);
  assert.equal(provenance.evidenceFile, evidenceFile);
  assert.equal(bundle.stats.modules, 6);
  assert.equal(bundle.stats.instantiations, 7);
});

test('resolveBackend(--evidence) refuses a stale-basis document', () => {
  const tmp = path.join(here, 'fixtures', '.tmp-bad-evidence.json');
  const doc = mutate((d) => { for (const inst of d.instances) inst.line1 -= 1; });
  fs.writeFileSync(tmp, JSON.stringify(doc));
  try {
    assert.throws(() => resolveBackend(fixture, { evidenceFile: tmp }), /off-by-one/);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI level: exit-code semantics and the R5 "same backend" default
// ---------------------------------------------------------------------------

function runCli(args) {
  // spawnSync, not execFileSync: several contracts here are about what the tool
  // SAYS on stderr (notes, caveats), and a helper that drops stderr would make
  // those untestable.
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

test('cli: evidence caps are validated, never silently replaced by the default', () => {
  for (const bad of [['--max-signals', 'abc'], ['--max-signals', '0'], ['--max-connections', '-1']]) {
    const r = runCli(['scan', fixture, '--backend', 'builtin', ...bad, '--json']);
    assert.equal(r.code, 2, `${bad.join(' ')} must be a usage error, not a fallback`);
    assert.match(r.stderr, /must be a positive integer/);
  }
});

test('cli: flags the builtin scanner cannot honour are declared ignored', () => {
  const r = runCli(['scan', fixture, '--backend', 'builtin', '-D', 'SIM', '--max-signals', '4', '--json']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /no effect on the builtin scanner/);
  assert.match(r.stderr, /--max-signals/, 'the ignored flag must be named');
  // --max-files DOES apply to the builtin scanner (as a hard ceiling), so it
  // must never be listed among the ignored flags — and the two engines must
  // still tell the same STORY even though the builtin one refuses where RTLens
  // discloses: neither may silently under-report coverage.
  assert.doesNotMatch(r.stderr, /--max-files/);
  const roomy = runCli(['scan', fixture, '--backend', 'builtin', '--max-files', '100', '--json']);
  assert.equal(roomy.code, 0, roomy.stderr);
  assert.doesNotMatch(roomy.stderr, /no effect on the builtin scanner/);
  const tight = runCli(['scan', fixture, '--backend', 'builtin', '--max-files', '2', '--json']);
  assert.equal(tight.code, 2, 'the builtin ceiling must refuse, not truncate');
  assert.match(tight.stderr, /exceeds 2 files/);
});

test('cli: rtlens passthrough caps are recorded in provenance (stand-in)', (t) => {
  if (!fs.existsSync(path.join(fixturePkg, 'package.json'))) {
    t.skip('fixture rtlens package missing');
    return;
  }
  const probe = probeRtlens({ pkgRoot: fixturePkg });
  if (!probe.available) {
    t.skip(`fixture rtlens package unusable here: ${probe.reason}`);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-caps-'));
  try {
    const capped = path.join(tmp, 'capped.json');
    const r = runCli(['scan', fixture, '--rtlens-root', fixturePkg, '-D', 'SIM',
      '--max-signals', '1', '--out', capped, '--json']);
    assert.equal(r.code, 0, r.stderr);
    const bundle = JSON.parse(fs.readFileSync(capped, 'utf8'));
    assert.equal(bundle.provenance.backendOptions.maxSignals, 1);
    assert.equal(bundle.provenance.backendOptions.maxConnections, undefined, 'record only what was given');
    assert.equal(bundle.provenance.defines.SIM, '1');

    // A default is not a decision: an uncapped run records nothing.
    const plain = path.join(tmp, 'plain.json');
    assert.equal(runCli(['scan', fixture, '--rtlens-root', fixturePkg, '--out', plain, '--json']).code, 0);
    assert.equal(JSON.parse(fs.readFileSync(plain, 'utf8')).provenance.backendOptions, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('cli: scan --evidence -> derive -> verify is green with no extra flags', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-ev-'));
  try {
    // The committed fixture's absolute root is a machine-independent
    // placeholder; hand the CLI a re-anchored copy so the spec replays verify
    // against a real directory without extra flags (R5).
    const anchored = path.join(tmp, 'evidence.json');
    fs.writeFileSync(anchored, JSON.stringify(fixtureEvidence(), null, 2));
    const bundleFile = path.join(tmp, 'b.json');
    const specFile = path.join(tmp, 's.json');
    const scan = runCli(['scan', fixture, '--evidence', anchored, '--out', bundleFile, '--json']);
    assert.equal(scan.code, 0);
    assert.equal(JSON.parse(scan.stdout).provenance.backend, 'rtlens');

    const derive = runCli(['derive', bundleFile, '--out', specFile, '--title', 't', '--project', 'p', '--json']);
    assert.equal(derive.code, 0);
    assert.equal(JSON.parse(derive.stdout).provenance.backend, 'rtlens');
    // The spec is the durable artifact: it must remember the evidence document
    // so verify can replay the SAME backend without being told (R5).
    const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
    assert.equal(spec.meta.derivedFrom.provenance.evidenceFile, anchored);

    const verify = runCli(['verify', specFile, '--json']);
    assert.equal(verify.code, 0);
    const receipt = JSON.parse(verify.stdout);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.metrics.backed, receipt.metrics.elements);
    assert.equal(receipt.metrics.hallucinationRisk, 0);
    assert.equal(receipt.provenance.backend, 'rtlens');
    assert.equal(receipt.backendOverride, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('cli: an explicit --backend that differs from the spec is stamped as an override', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-ov-'));
  try {
    // Re-anchored copy: see the evidence-root note in the test above.
    const anchored = path.join(tmp, 'evidence.json');
    fs.writeFileSync(anchored, JSON.stringify(fixtureEvidence(), null, 2));
    const bundleFile = path.join(tmp, 'b.json');
    const specFile = path.join(tmp, 's.json');
    runCli(['scan', fixture, '--evidence', anchored, '--out', bundleFile, '--json']);
    runCli(['derive', bundleFile, '--out', specFile, '--json']);
    const verify = runCli(['verify', specFile, '--backend', 'builtin', '--json']);
    assert.equal(verify.code, 0);
    const receipt = JSON.parse(verify.stdout);
    assert.equal(receipt.provenance.backend, 'builtin');
    assert.equal(receipt.backendOverride, true, 'R5: switching backend must be visible in the receipt');
    assert.equal(receipt.metrics.hallucinationRisk, 0, 'both backends agree on the same facts');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('cli: forced rtlens with an unusable package exits 2 (usage error, never 1)', () => {
  const missing = path.join(here, 'fixtures', 'no-such-rtlens-install');
  const r = runCli(['scan', fixture, '--backend', 'rtlens', '--rtlens-root', missing, '--json']);
  assert.equal(r.code, 2, 'unavailable+forced is a usage error, not a verification failure');
});

test('cli: unknown backend name exits 2', () => {
  const r = runCli(['scan', fixture, '--backend', 'magic', '--json']);
  assert.equal(r.code, 2);
});

test('cli: doctor reports backend availability and still passes while degraded', () => {
  const r = runCli(['doctor', '--json']);
  assert.equal(r.code, 0, 'a missing RTLens must not fail doctor');
  const report = JSON.parse(r.stdout);
  assert.equal(report.ok, true);
  assert.ok(report.backend, 'backend report present');
  assert.equal(typeof report.backend.rtlens.available, 'boolean');
  assert.equal(report.backend.rtlens.requiredVersion, '6.2.0');
  assert.equal(report.backend.builtin.available, true);
  assert.ok(typeof report.backend.rtlens.reason === 'string' && report.backend.rtlens.reason.length > 0);
});

test('cli: R6 disclosure reaches receipt + HTML + wiki when the backend is degraded', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-r6-'));
  try {
    const specFile = path.join(tmp, 's.json');
    const prefix = path.join(tmp, 'out');
    const derive = runCli(['derive', fixture, '--backend', 'builtin', '--out', specFile, '--title', 't', '--project', 'p', '--json']);
    assert.equal(derive.code, 0, 'derive with an explicitly degraded backend still succeeds');
    assert.equal(JSON.parse(derive.stdout).provenance.degraded, true);

    // An explicitly requested builtin backend is still recorded as degraded:
    // choosing the lower evidence grade is never "not degraded".
    const deliver = runCli(['deliver', specFile, '--out', prefix, '--json']);
    assert.equal(deliver.code, 0);
    const receipt = JSON.parse(deliver.stdout);
    assert.equal(receipt.verified, true);
    assert.equal(receipt.provenance.backend, 'builtin');
    assert.equal(receipt.provenance.degraded, true);
    assert.ok(receipt.provenance.reason.length > 0);

    const html = fs.readFileSync(`${prefix}.html`, 'utf8');
    assert.ok(html.includes('证据后端降级'), 'degradation banner in the HTML viewer');
    const wiki = fs.readFileSync(`${prefix}.wiki.md`, 'utf8');
    assert.ok(wiki.includes('证据后端降级'), 'degradation header in the wiki page');
    const receiptFile = JSON.parse(fs.readFileSync(`${prefix}.receipt.json`, 'utf8'));
    assert.equal(receiptFile.provenance.degraded, true, 'degradation in .receipt.json');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// the same CLI, driven against a stand-in RTLens package
// ---------------------------------------------------------------------------

test('cli: --backend rtlens end to end through the fixture package, cross-checked by builtin', (t) => {
  if (!fs.existsSync(path.join(fixturePkg, 'package.json'))) {
    t.skip('fixture rtlens package missing');
    return;
  }
  const probe = probeRtlens({ pkgRoot: fixturePkg });
  if (!probe.available) {
    // No usable python: the fake CLI cannot answer, so skip rather than fail.
    t.skip(`fixture rtlens package unusable here: ${probe.reason}`);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-rl-'));
  try {
    const bundleFile = path.join(tmp, 'b.json');
    const specFile = path.join(tmp, 's.json');
    const scan = runCli(['scan', fixture, '--backend', 'rtlens', '--rtlens-root', fixturePkg, '--out', bundleFile, '--json', '-D', 'SIM']);
    assert.equal(scan.code, 0);
    const scanReport = JSON.parse(scan.stdout);
    assert.equal(scanReport.provenance.backend, 'rtlens');
    assert.equal(scanReport.provenance.degraded, false);
    assert.equal(scanReport.stats.modules, 6);
    assert.equal(scanReport.stats.instantiations, 7);

    const derive = runCli(['derive', bundleFile, '--out', specFile, '--title', 't', '--project', 'p', '--json']);
    assert.equal(derive.code, 0);
    const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
    assert.equal(spec.meta.derivedFrom.provenance.backend, 'rtlens');

    // RTLens-built spec, RTLens-built evidence: everything must resolve.
    const verify = runCli(['verify', specFile, '--rtlens-root', fixturePkg, '--json']);
    assert.equal(verify.code, 0);
    const receipt = JSON.parse(verify.stdout);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.metrics.broken, 0);
    assert.equal(receipt.metrics.hallucinationRisk, 0);

    // Cross-backend equivalence: the builtin scanner grades the SAME spec at
    // risk 0 as well, which is the "one fact set, two implementations" proof.
    const cross = runCli(['verify', specFile, '--backend', 'builtin', '--json']);
    assert.equal(cross.code, 0);
    const crossReceipt = JSON.parse(cross.stdout);
    assert.equal(crossReceipt.metrics.broken, 0);
    assert.equal(crossReceipt.metrics.hallucinationRisk, 0);
    assert.equal(crossReceipt.backendOverride, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
