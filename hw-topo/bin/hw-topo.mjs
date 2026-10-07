#!/usr/bin/env node
// hw-topo CLI — evidence-first hardware topology diagrams for DSH.
//
// Pipeline: scan -> derive -> (curate) -> verify -> deliver
//   scan    index an RTL tree into an evidence bundle (file:line + sha256)
//   derive  mechanically build a topology spec from the bundle (zero authorship)
//   validate structural check of a spec (shape + referential integrity)
//   verify  re-scan the RTL root and grade every element: backed/disclosed/
//           unbacked/broken; hallucinationRisk must be 0 to pass
//   deliver render interactive HTML + standalone SVG + wiki index + receipt
//   search  find hardware repos on GitHub (no download)
//   gh      download a repo at a pinned commit, run the full pipeline, and
//           emit SVG/wiki evidence links that permalinks back to GitHub source
//   doctor  environment self-check
//   demo    end-to-end run on the bundled fixture
//
// Evidence backend: hw-topo can consume RTLens index evidence instead of its
// own regex scanner (--backend auto|rtlens|builtin, RTLens needs >= 6.2.0).
// Whatever produced a spec travels in `provenance` (bundle -> spec.meta ->
// receipt), and `verify` reuses the SAME backend by default: grading one
// backend's coordinates against another's produces false "broken" verdicts.
//
// Exit codes: 0 ok · 1 verification failed · 2 usage/IO error.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanRtl } from '../lib/scan-rtl.mjs';
import { deriveSpec, structuralDiagnostics } from '../lib/spec.mjs';
import { verifySpec, cleanReceipt } from '../lib/verify.mjs';
import { resolveBackend, probeRtlens, runRtlensEvidence, MIN_RTLENS_VERSION } from '../lib/rtlens-backend.mjs';
import { EVIDENCE_SCHEMA } from '../lib/evidence-adapter.mjs';
import { runCrossCheck, witnessFromBuiltin, witnessFromEvidence, CROSS_CHECK_SCHEMA } from '../lib/cross-check.mjs';
import { renderTopologySvg, svgExportStyle } from '../lib/render-svg.mjs';
import { buildViewerHtml } from '../lib/viewer.mjs';
import { buildWikiMarkdown } from '../lib/wiki.mjs';
import { atomicWrite, sha256Hex, sourceLine, resolveInsideRoot, escapeHtml, parseJson } from '../lib/util.mjs';
import { searchRepos, repoMeta, resolveCommit, downloadTarball, extractTarGz, githubBlobUrl } from '../lib/github.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, '..');

const BACKENDS = ['auto', 'rtlens', 'builtin'];

function usage(code = 2) {
  process.stderr.write(`usage:
  hw-topo scan <rtlRoot> [--out bundle.json] [--backend auto|rtlens|builtin]
               [--evidence evidence.json] [-D NAME]... [--cross-check[-strict]] [--json]
  hw-topo derive <bundleOrRoot> [--out spec.json] [--focus <module>] [--no-groups]
                 [--backend auto|rtlens|builtin] [--evidence evidence.json]
                 [--title <t>] [--project <name>] [-D NAME]... [--json]
  hw-topo validate <spec.json> [--json]
  hw-topo verify <spec.json> [--root <rtlRoot>] [--bundle bundle.json]
                 [--backend auto|rtlens|builtin] [--evidence evidence.json]
                 [-D NAME]... [--cross-check[-strict]] [--json]
  hw-topo deliver <spec.json> [--root <rtlRoot>] [--out <prefix>] [--allow-unverified]
                  [--backend auto|rtlens|builtin] [--bundle bundle.json]
                  [--cross-check[-strict]] [--json]
  hw-topo search "<query>" [--limit N] [--json]
  hw-topo gh <owner/repo> [--ref <branch|tag|sha>] [--focus <module>] [--out <dir>]
             [--title <t>] [--no-groups] [--backend auto|rtlens|builtin] [--json]
  hw-topo doctor [--json]
  hw-topo demo <outputDir> [--json]

evidence backend:
  auto      (default) use RTLens when it is installed and >= ${MIN_RTLENS_VERSION}, else fall back to the
            built-in scanner with provenance.degraded=true and a reason
  rtlens    require RTLens; unavailable is a usage error (exit 2), never a silent fallback
  builtin   force the built-in regex scanner (always recorded as degraded)
  --evidence <file>  consume a saved \`rtlens evidence --json\` document (${EVIDENCE_SCHEMA})
  -D NAME / --define NAME   preprocessor define passed through to RTLens (repeatable)
  -I DIR / --include-path DIR   include search path passed through to RTLens (repeatable)
  --max-files N             index at most N files (RTLens default 5000)
  --max-signals N           per-module signal cap; exceeding it is flagged, never silent
  --max-connections N       per-instance connection cap; same disclosure rule
                            (the caps only change what RTLens reads; the built-in scanner
                             has no signal detail and says so when they are ignored)
  --rtlens-root <dir>       RTLens package root (else $HW_TOPO_RTLENS_ROOT / $RTLENS_HOME /
                            require.resolve / node_modules walk / $DSH_HOME profiles)
  --python <exe>            python interpreter (else $HW_TOPO_PYTHON / python / python3 / py -3)

cross-check (${CROSS_CHECK_SCHEMA}):
  --cross-check             also run the OTHER engine and disclose every divergence
                            (coverage differences are reported, never silently reconciled)
  --cross-check-strict      same, but a coordinate mismatch makes \`verify\` FAIL, and an
                            uncheckable witness also fails (strict means unproven is not passed)
`);
  process.exit(code);
}

/**
 * Parse argv. Long flags take a value from the next argument; `-D`/`--define`
 * are the only repeatable flags (collected into `flags['--define']`), and both
 * the detached (`-D SIM`) and attached (`-DSIM`) spellings are accepted.
 */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '--no-groups' || a === '--allow-unverified' ||
        a === '--cross-check' || a === '--cross-check-strict') {
      flags[a] = true;
    } else if (a === '-D' || a === '--define') {
      const value = argv[++i];
      if (value === undefined) usage();
      if (!flags['--define']) flags['--define'] = [];
      flags['--define'].push(value);
    } else if (a.startsWith('-D') && a.length > 2) {
      if (!flags['--define']) flags['--define'] = [];
      flags['--define'].push(a.slice(2));
    } else if (a.startsWith('--define=')) {
      if (!flags['--define']) flags['--define'] = [];
      flags['--define'].push(a.slice('--define='.length));
    } else if (a === '-I' || a === '--include-path') {
      const value = argv[++i];
      if (value === undefined) usage();
      if (!flags['--include-path']) flags['--include-path'] = [];
      flags['--include-path'].push(value);
    } else if (a.startsWith('--include-path=')) {
      if (!flags['--include-path']) flags['--include-path'] = [];
      flags['--include-path'].push(a.slice('--include-path='.length));
    } else if (a === '--out' || a === '--root' || a === '--bundle' || a === '--focus' ||
               a === '--title' || a === '--project' || a === '--ref' || a === '--limit' ||
               a === '--backend' || a === '--evidence' || a === '--rtlens-root' || a === '--python' ||
               a === '--max-files' || a === '--max-signals' || a === '--max-connections') {
      flags[a] = argv[++i];
      if (flags[a] === undefined) usage();
    } else if (a.startsWith('--')) {
      process.stderr.write(`unknown flag: ${a}\n`);
      usage();
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function readJson(file, what) {
  try {
    return parseJson(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    process.stderr.write(`cannot read ${what} ${file}: ${error.message}\n`);
    process.exit(2);
  }
}

function emitJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Validate an optional positive-integer flag.
 * `undefined` means "not given" (use the backend default). A malformed value
 * exits 2 rather than silently reverting to the default, because the caps
 * change what the evidence contains.
 */
function positiveIntFlag(value, name) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(`${name} must be a positive integer (got ${JSON.stringify(value)})\n`);
    process.exit(2);
  }
  return n;
}

/**
 * Backend options shared by every command that needs an evidence bundle.
 * `--evidence` wins over the backend choice; `--backend` forces one when given.
 * `provenance` is what makes a degraded run visible (contract R6), so the
 * resolved bundle always carries it.
 */
function backendOptions(flags) {
  const defines = flags['--define'] || [];
  const includePaths = flags['--include-path'] || [];
  // A missing cap means "use the backend's default"; a malformed one is a usage
  // error, never a silent fallback to the default (that would change what the
  // evidence contains without saying so).
  const maxFiles = positiveIntFlag(flags['--max-files'], '--max-files');
  const maxSignals = positiveIntFlag(flags['--max-signals'], '--max-signals');
  const maxConnections = positiveIntFlag(flags['--max-connections'], '--max-connections');
  // The builtin scanner is regex-only: no `ifdef evaluation, no signal detail.
  // These knobs would be silently meaningless there, so say so once.
  if (flags['--backend'] === 'builtin') {
    const ignored = [];
    if (defines.length) ignored.push('-D/--define');
    if (includePaths.length) ignored.push('-I/--include-path');
    if (maxSignals !== undefined) ignored.push('--max-signals');
    if (maxConnections !== undefined) ignored.push('--max-connections');
    if (ignored.length) {
      process.stderr.write(`note: ${ignored.join(', ')} ${ignored.length > 1 ? 'have' : 'has'} no effect on the builtin scanner (no preprocessor / signal detail); forwarded to RTLens only\n`);
    }
  }
  return {
    backend: flags['--backend'],
    evidenceFile: flags['--evidence'],
    defines,
    includePaths,
    maxFiles,
    maxSignals,
    maxConnections,
    pkgRoot: flags['--rtlens-root'],
    python: flags['--python'],
  };
}

/**
 * `resolveBackend` throws when a forced backend is unusable or when an
 * evidence document fails transcription. Per the CLI contract that is a
 * usage/IO error: report it on stderr and exit 2 (never exit 1, which means
 * "the diagram failed verification").
 */
function resolveBackendOrExit(root, flags) {
  try {
    return resolveBackend(root, backendOptions(flags));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}

/** `--backend` must name a known backend; anything else is a usage error. */
function checkBackendFlag(flags) {
  if (flags['--backend'] !== undefined && !BACKENDS.includes(flags['--backend'])) {
    process.stderr.write(`unknown backend: ${flags['--backend']} (expected ${BACKENDS.join(' | ')})\n`);
    usage();
  }
}

/** One stderr line per run when the evidence grade dropped (contract R6). */
function writeDegradedWarning(provenance) {
  if (provenance?.degraded) {
    process.stderr.write(`⚠ evidence backend: ${provenance.backend} (degraded) — ${provenance.reason}\n`);
  }
}

/**
 * Surface the producer's own caveats at the moment of scanning. They are not
 * failures, but a scan that says nothing about them reads as "everything was
 * read and everything was clean".
 */
function writeEvidenceCaveatWarning(diag) {
  if (!diag) return;
  if (Number.isInteger(diag.parseErrors) && diag.parseErrors > 0) {
    process.stderr.write(`⚠ evidence caveat: the evidence engine reported ${diag.parseErrors} parse error(s) — coordinates in those files may be unreliable\n`);
  }
  if (Number.isInteger(diag.outsideRootCount) && diag.outsideRootCount > 0) {
    process.stderr.write(`⚠ evidence caveat: ${diag.outsideRootCount} file(s) outside the root were indexed and then excluded — coverage is incomplete\n`);
  }
  if (diag.filesCapped === true) {
    process.stderr.write(`⚠ evidence caveat: indexing stopped at the --max-files cap — there are files that were never read\n`);
  }
}

/**
 * Why did the gate fail? It must never say "unproven content" when every
 * element is in fact backed — that is the tool contradicting itself in two
 * adjacent sentences, which is the exact failure mode this project exists to
 * remove. A strict cross-check can fail a receipt whose evidence is perfect.
 */
function verifyFailureReason(receipt) {
  const m = receipt.metrics;
  if (receipt.findings.some((f) => f.code === 'crosscheck/coordinate-mismatch')) {
    return `strict cross-check found ${receipt.crossCheck?.counts?.coordinateMismatches ?? '?'} coordinate mismatch(es); the evidence itself is fully backed (${m.backed}/${m.elements})`;
  }
  if (receipt.findings.some((f) => f.code === 'crosscheck/unavailable')) {
    return `strict cross-check could not run: ${receipt.crossCheck?.secondaryUnavailable ?? 'witness unavailable'}`;
  }
  return `unbacked ${m.unbacked}, broken ${m.broken}`;
}

/**
 * Cross-check policy for this invocation.
 *
 * `--cross-check` is opt-in (it costs a second engine run), but a `strict`
 * policy RECORDED in the spec is honoured even without the flag: a spec that
 * claims a strict cross-check must be re-checked, never trusted. Same reason
 * `verify` re-scans instead of believing the spec's own evidence.
 */
function crossCheckPolicy(flags, spec) {
  if (flags['--cross-check-strict']) return 'strict';
  if (flags['--cross-check']) return 'warn';
  const recorded = spec?.meta?.diagnostics?.crossCheck ?? null;
  return recorded?.policy === 'strict' ? 'strict' : null;
}

/**
 * Run the cross-check for a resolved bundle. The primary engine is whichever
 * produced the bundle; the witness is the OTHER engine, and it is never allowed
 * to change the diagram — it only gets to disagree out loud (see
 * lib/cross-check.mjs for why a coverage difference must not be confused with a
 * coordinate mismatch).
 */
function crossCheckFor(root, resolved, flags, policy) {
  const primaryBackend = resolved.provenance?.backend ?? resolved.backend ?? 'builtin';
  const witness = primaryBackend === 'rtlens'
    ? witnessFromBuiltin(scanRtl(root))
    : buildRtlensWitness(root, flags);
  return runCrossCheck(root, {
    primaryBundle: resolved.bundle,
    primaryBackend,
    secondary: witness,
    policy,
    defines: resolved.provenance?.defines ?? {},
  });
}

/** The RTLens witness for a builtin-primary bundle. Never throws. */
function buildRtlensWitness(root, flags) {
  try {
    const probe = probeRtlens({ pkgRoot: flags['--rtlens-root'], python: flags['--python'] });
    if (!probe.available) return { unavailable: true, reason: probe.reason };
    return witnessFromEvidence(runRtlensEvidence({ root, probe, defines: flags['--define'] || [] }));
  } catch (error) {
    return { unavailable: true, reason: error.message };
  }
}

/** One stderr block per run so a human reviewer sees the divergence summary. */
function writeCrossCheckWarning(crossCheck) {
  if (!crossCheck) return;
  if (!crossCheck.checked) {
    process.stderr.write(`cross-check: NOT performed — ${crossCheck.secondaryUnavailable}\n`);
    return;
  }
  const { counts, primary, secondary, divergences } = crossCheck;
  if (divergences.length === 0) {
    process.stderr.write(`cross-check: ${primary} vs ${secondary} agree on all ${counts.modules.shared + counts.instances.shared} shared facts\n`);
    return;
  }
  const byCategory = Object.entries(counts.byCategory).map(([k, v]) => `${k}×${v}`).join(', ');
  process.stderr.write(`${counts.coordinateMismatches > 0 ? '⚠' : '·'} cross-check: ${primary} vs ${secondary} — ${divergences.length} divergence(s) [${byCategory}]${crossCheck.truncated ? ' (truncated)' : ''}\n`);
  for (const d of divergences.slice(0, 5)) {
    process.stderr.write(`    ${d.category} ${d.kind} ${d.identity} primary=[${d.primaryLines}] witness=[${d.secondaryLines}]${d.detail ? ` — ${d.detail}` : ''}\n`);
  }
  if (divergences.length > 5) process.stderr.write(`    ... ${divergences.length - 5} more (see "crossCheck" in the bundle/receipt)\n`);
}

/**
 * Strict cross-check → receipt findings. Two ways to fail, both deliberate:
 * a coordinate mismatch, and an UNCHECKABLE witness. "Strict" has to mean that
 * unproven is not passed, otherwise it would only ever report good news.
 */
function applyStrictCrossCheck(receipt, crossCheck) {
  if (!crossCheck || crossCheck.policy !== 'strict') return;
  if (!crossCheck.checked) {
    receipt.findings.push({
      severity: 'error',
      code: 'crosscheck/unavailable',
      subject: { primary: crossCheck.primary },
      message: `strict cross-check could not run: ${crossCheck.secondaryUnavailable}`,
      supportedFixes: ['install/enable the other engine', 'or use --cross-check instead of --cross-check-strict'],
    });
    receipt.ok = false;
    return;
  }
  const mismatches = crossCheck.divergences.filter((d) => d.category === 'coordinate-mismatch');
  for (const d of mismatches.slice(0, 25)) {
    receipt.findings.push({
      severity: 'error',
      code: 'crosscheck/coordinate-mismatch',
      subject: { kind: d.kind, identity: d.identity, file: d.file },
      message: `${d.kind} ${d.identity}: the two engines never point at the same line (primary [${d.primaryLines}] vs witness [${d.secondaryLines}])`,
      supportedFixes: ['treat the coordinates as unverified until the two engines agree', 'check for an off-by-one or a path-basis mismatch'],
    });
  }
  if (mismatches.length > 0) receipt.ok = false;
}

/**
 * Load a bundle for derive/verify/deliver.
 *
 * - an explicit `--bundle <file>` or an existing `<bundleOrRoot>` file is read
 *   as-is; if it carries provenance, that provenance is kept (it is the record
 *   of how the evidence was produced), otherwise the file is treated as a
 *   builtin-backend artifact.
 * - anything else is scanned through `resolveBackend`, so the CLI entry point
 *   and the library agree on backend selection.
 */
function loadBundleOrScan(target, flags) {
  const explicit = flags['--bundle'] || target;
  if (explicit && fs.existsSync(explicit) && fs.statSync(explicit).isFile()) {
    const bundle = readJson(explicit, 'bundle');
    const provenance = bundle.provenance ?? {
      backend: 'builtin',
      degraded: true,
      reason: `bundle ${explicit} was read from disk without provenance (legacy or hand-made artifact)`,
      evidenceSchema: null,
      tool: { name: bundle.tool ?? 'unknown', version: null },
      defines: {},
      rootAbs: bundle.root ?? null,
    };
    bundle.provenance = provenance;
    return { bundle, provenance, scanned: false, out: explicit, bundlePath: explicit };
  }
  const root = flags['--root'] || target;
  return { ...resolveBackendOrExit(root, flags), bundlePath: null };
}

/** Collect evidence snippets (3-line windows) for the viewer HTML. */
function collectSnippets(spec, root, cap = 1400) {
  const wanted = new Map(); // file -> Set(lines)
  for (const node of spec.nodes || []) {
    for (const ev of node.evidence || []) addLine(wanted, ev);
  }
  for (const edge of spec.instances || []) {
    for (const ev of edge.evidence || []) addLine(wanted, ev);
  }
  for (const conn of spec.connections || []) {
    for (const ev of conn.evidence || [{ file: conn.file, line: conn.line }]) addLine(wanted, ev);
  }
  const snippets = {};
  let count = 0;
  for (const [file, lines] of wanted) {
    const abs = resolveInsideRoot(root, file); // no reads outside the root
    if (!abs || !fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    for (const line of lines) {
      if (count++ > cap) return snippets;
      const rows = [];
      for (let d = -1; d <= 1; d++) {
        const t = sourceLine(text, line + d);
        if (t !== null) rows.push({ n: line + d, t });
      }
      if (rows.length) snippets[`${file}:${line}`] = rows;
    }
  }
  return snippets;
}

function addLine(wanted, ev) {
  if (!ev?.file || !Number.isInteger(ev.line) || ev.line < 1) return;
  if (!wanted.has(ev.file)) wanted.set(ev.file, new Set());
  wanted.get(ev.file).add(ev.line);
}

function cmdScan([root], flags) {
  if (!root) usage();
  checkBackendFlag(flags);
  const resolved = resolveBackendOrExit(root, flags);
  const { bundle, provenance } = resolved;
  // --cross-check touches only `diagnostics`, never the facts: the primary
  // engine's rows are what the bundle says, and the witness cannot change them.
  const policy = crossCheckPolicy(flags, null);
  let crossCheck = null;
  if (policy) {
    crossCheck = crossCheckFor(root, resolved, flags, policy);
    bundle.diagnostics = { ...(bundle.diagnostics ?? {}), crossCheck };
  }
  if (flags['--out']) atomicWrite(flags['--out'], `${JSON.stringify(bundle, null, 2)}\n`);
  writeDegradedWarning(provenance);
  writeEvidenceCaveatWarning(bundle.diagnostics);
  writeCrossCheckWarning(crossCheck);
  if (flags['--json']) {
    emitJson({
      ok: true,
      root: bundle.root,
      stats: bundle.stats,
      out: flags['--out'] || null,
      provenance,
      crossCheck,
    });
  } else {
    process.stderr.write(`scanned ${bundle.stats.files} files: ${bundle.stats.modules} modules, ${bundle.stats.instantiations} instantiations (${bundle.stats.unresolvedVendor} vendor primitives, ${bundle.stats.unresolvedUnknown} unknown)\n`);
  }
  return 0;
}

function cmdDerive([target], flags) {
  if (!target) usage();
  checkBackendFlag(flags);
  const { bundle, provenance, bundlePath } = loadBundleOrScan(target, flags);
  const spec = deriveSpec(bundle, {
    focus: flags['--focus'] || null,
    groupByDir: !flags['--no-groups'],
    title: flags['--title'],
    projectName: flags['--project'],
  });
  // deriveSpec already copied bundle.provenance into meta.derivedFrom; re-state
  // it here so a repo-authored spec that removed the meta block is repaired.
  spec.meta.derivedFrom.provenance = provenance;
  // A cross-check is a diagnostic, so it rides along in meta.diagnostics for the
  // reviewer and for `verify` (which re-runs it rather than trusting it).
  if (bundle.diagnostics?.crossCheck) {
    spec.meta.diagnostics = { ...(spec.meta.diagnostics ?? {}), crossCheck: bundle.diagnostics.crossCheck };
  }
  const out = flags['--out'] || 'topology.json';
  atomicWrite(out, `${JSON.stringify(spec, null, 2)}\n`);
  const struct = structuralDiagnostics(spec).filter((f) => f.severity === 'error');
  writeDegradedWarning(provenance);
  if (flags['--json']) {
    emitJson({
      ok: struct.length === 0,
      out,
      nodes: spec.nodes.length,
      instances: spec.instances.length,
      groups: spec.groups.length,
      structuralErrors: struct.length,
      bundle: bundlePath,
      provenance,
    });
  } else {
    process.stderr.write(`derived ${spec.nodes.length} nodes / ${spec.instances.length} instance edges -> ${out}\n`);
  }
  return struct.length ? 1 : 0;
}

function cmdValidate([specFile], flags) {
  if (!specFile) usage();
  const spec = readJson(specFile, 'spec');
  const findings = structuralDiagnostics(spec);
  const errors = findings.filter((f) => f.severity === 'error');
  if (flags['--json']) emitJson({ ok: errors.length === 0, errors: errors.length, findings });
  else for (const f of findings) process.stderr.write(`${f.severity}: ${f.code} — ${f.message}\n`);
  return errors.length ? 1 : 0;
}

/**
 * Resolve the bundle that `verify`/`deliver` grade a spec against.
 *
 * Contract R5: scan and verify must use the same backend. Two rules:
 *   - a spec that recorded `meta.derivedFrom.provenance.backend` reuses it by
 *     default, unless the caller passes `--backend` explicitly (then the
 *     receipt is stamped `backendOverride: true` so nobody has to guess);
 *   - `--bundle` / `--evidence` still let the caller inject exact evidence.
 */
function resolveVerifyBundle(spec, root, flags) {
  checkBackendFlag(flags);
  const specProvenance = spec.meta?.derivedFrom?.provenance ?? null;
  const explicitBackend = flags['--backend'] ?? null;
  const specBackend = specProvenance?.backend ?? null;
  const backend = explicitBackend ?? specBackend ?? 'auto';
  const backendOverride = Boolean(explicitBackend && specBackend && explicitBackend !== specBackend);

  if (flags['--evidence']) {
    const resolved = resolveBackend(root, backendOptions(flags));
    return { ...resolved, backendOverride, backendSource: 'evidence-file' };
  }
  // A spec derived from an `--evidence` document replays that same document.
  // It IS the evidence that produced the spec, so reusing it is R5-compliant
  // (same backend) and makes `scan --evidence` -> `verify` work with no flags.
  const recordedEvidence = specProvenance?.evidenceFile ?? null;
  if (!explicitBackend && recordedEvidence && fs.existsSync(recordedEvidence)) {
    const resolved = resolveBackend(root, { ...backendOptions(flags), evidenceFile: recordedEvidence });
    return { ...resolved, backendOverride: false, backendSource: 'spec-evidence-file' };
  }
  if (flags['--bundle']) {
    const bundle = readJson(flags['--bundle'], 'bundle');
    if (!bundle.provenance) {
      bundle.provenance = {
        backend: 'builtin',
        degraded: true,
        reason: `bundle ${flags['--bundle']} was read from disk without provenance`,
        evidenceSchema: null,
        tool: { name: bundle.tool ?? 'unknown', version: null },
        defines: {},
        rootAbs: bundle.root ?? null,
      };
    }
    return { bundle, provenance: bundle.provenance, backend: bundle.provenance.backend, degraded: bundle.provenance.degraded, reason: bundle.provenance.reason, scanned: false, backendOverride, backendSource: 'bundle-file' };
  }
  const resolved = resolveBackend(root, { ...backendOptions(flags), backend });
  return { ...resolved, backendOverride, backendSource: specBackend && !explicitBackend ? 'spec-provenance' : 'flag' };
}

/**
 * `verify`/`deliver` variant of resolveBackendOrExit: when the spec's recorded
 * backend cannot be reused (contract R5 forbids switching silently), say what
 * the user can do instead of leaving a bare "unavailable".
 */
function resolveVerifyBundleOrExit(spec, root, flags) {
  try {
    return resolveVerifyBundle(spec, root, flags);
  } catch (error) {
    const specBackend = spec.meta?.derivedFrom?.provenance?.backend ?? null;
    const recordedEvidence = spec.meta?.derivedFrom?.provenance?.evidenceFile ?? null;
    process.stderr.write(`${error.message}\n`);
    if (specBackend && !flags['--backend']) {
      process.stderr.write(`this spec records backend "${specBackend}"${recordedEvidence ? ` (evidence ${recordedEvidence} is gone or unreadable)` : ''}; re-run scan + derive, or re-run verify with the same backend available: --rtlens-root <dir> / --evidence <file> / --bundle <file>, or override deliberately with --backend builtin\n`);
    }
    process.exit(2);
  }
}

function cmdVerify([specFile], flags) {
  if (!specFile) usage();
  const spec = readJson(specFile, 'spec');
  const root = flags['--root'] || spec.meta?.project?.root;
  const resolved = resolveVerifyBundleOrExit(spec, root, flags);
  try {
    const receipt = cleanReceipt(verifySpec(spec, {
      root,
      bundle: resolved.bundle,
      defines: resolved.provenance?.defines,
    }));
    receipt.backendOverride = resolved.backendOverride;
    // Structure is not evidence, but an unverifiable structure cannot be a
    // PASS: `deliver` already refuses such a spec, and one tool contradicting
    // itself about one file is exactly the confusion this project removes.
    // (Found for real: `derive` on an empty scan writes a 0-node spec and exits
    // 1, while `verify` used to call that same file green with risk 0%.)
    for (const f of structuralDiagnostics(spec).filter((x) => x.severity === 'error')) {
      if (!receipt.findings.some((x) => x.code === f.code && x.message === f.message)) receipt.findings.push(f);
      receipt.ok = false;
    }
    const policy = crossCheckPolicy(flags, spec);
    let crossCheck = null;
    if (policy) {
      crossCheck = crossCheckFor(root, resolved, flags, policy);
      receipt.crossCheck = crossCheck;
      applyStrictCrossCheck(receipt, crossCheck);
    }
    writeDegradedWarning(resolved.provenance);
    writeCrossCheckWarning(crossCheck);
    if (flags['--json']) emitJson(receipt);
    else {
      const m = receipt.metrics;
      process.stderr.write(`verify: ${receipt.ok ? 'PASS' : 'FAIL'} — backed ${m.backed}/${m.elements}, disclosed ${m.disclosed}, unbacked ${m.unbacked}, broken ${m.broken} (risk ${(m.hallucinationRisk * 100).toFixed(2)}%) [backend ${resolved.backend}${resolved.degraded ? ' degraded' : ''}${resolved.backendOverride ? ' override' : ''}${crossCheck?.counts?.coordinateMismatches ? ' cross-check:COORDINATE-MISMATCH' : ''}]\n`);
      for (const f of receipt.findings) process.stderr.write(`  ${f.code}: ${f.message}\n`);
    }
    return receipt.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`verify error: ${error.message}\n`);
    return 2;
  }
}

function cmdDeliver([specFile], flags) {
  if (!specFile) usage();
  const spec = readJson(specFile, 'spec');
  const structErrors = structuralDiagnostics(spec).filter((f) => f.severity === 'error');
  if (structErrors.length) {
    for (const f of structErrors) process.stderr.write(`structure: ${f.code} — ${f.message}\n`);
    return 2;
  }
  const root = flags['--root'] || spec.meta?.project?.root;
  const resolved = resolveVerifyBundleOrExit(spec, root, flags);
  let receipt = null;
  try {
    receipt = cleanReceipt(verifySpec(spec, {
      root,
      bundle: resolved.bundle,
      defines: resolved.provenance?.defines,
    }));
    receipt.backendOverride = resolved.backendOverride;
  } catch (error) {
    process.stderr.write(`deliver blocked — verification could not run: ${error.message}\n`);
    return 2;
  }
  writeDegradedWarning(resolved.provenance);
  const policy = crossCheckPolicy(flags, spec);
  let crossCheck = null;
  if (policy) {
    crossCheck = crossCheckFor(root, resolved, flags, policy);
    receipt.crossCheck = crossCheck;
    applyStrictCrossCheck(receipt, crossCheck);
    writeCrossCheckWarning(crossCheck);
    // An --allow-unverified delivery keeps ok=false; stamp the override
    // explicitly so nobody has to infer it from the risk number.
    if (flags['--allow-unverified'] && !receipt.ok) receipt.deliveredUnverified = true;
  } else if (flags['--allow-unverified'] && !receipt.ok) {
    receipt.deliveredUnverified = true;
  }
  if (!receipt.ok && !flags['--allow-unverified']) {
    const reason = verifyFailureReason(receipt);
    process.stderr.write(`deliver blocked — verify failed (${reason}). Fix the spec or pass --allow-unverified to stamp a warning.\n`);
    if (flags['--json']) emitJson({ ok: false, blocked: 'verify', receipt });
    return 1;
  }

  const ext = path.extname(specFile);
  const baseName = path.basename(specFile, ext).replace(/\.topology$/, '') || 'topology';
  const outPrefix = flags['--out'] || path.join(path.dirname(path.resolve(specFile)), baseName);
  const htmlFile = `${outPrefix}.html`;
  const svgFile = `${outPrefix}.svg`;
  const wikiFile = `${outPrefix}.wiki.md`;
  const receiptFile = `${outPrefix}.receipt.json`;

  const { svg } = renderTopologySvg(spec, { receipt });
  const snippets = collectSnippets(spec, root);
  const html = buildViewerHtml({ spec, svg, snippets, receipt });
  // Contract R6: degradation must be visible in the HTML, not only in the
  // receipt — otherwise a regex-grade diagram looks like index-grade evidence.
  const degraded = resolved.provenance?.degraded ? resolved.provenance : null;
  const xc = receipt.crossCheck ?? null;
  const banners = [
    degraded
      ? `<div style="padding:10px 22px;color:#b45309;font-weight:600">⚠ 证据后端降级:${escapeHtml(degraded.backend)} — ${escapeHtml(degraded.reason)}</div>`
      : '',
    xc && xc.checked && xc.counts?.coordinateMismatches
      ? `<div style="padding:10px 22px;color:#dc2626;font-weight:600">⚠ 交叉核对:${escapeHtml(xc.primary)} 与 ${escapeHtml(xc.secondary)} 在同一批事实上给出了不同行号(${xc.counts.coordinateMismatches} 处)——坐标不可信</div>`
      : '',
    xc && xc.checked && xc.divergences.length > 0 && !xc.counts?.coordinateMismatches
      ? `<div style="padding:10px 22px;color:#0f766e;font-weight:600">· 交叉核对:${xc.divergences.length} 处覆盖差异(${escapeHtml(Object.keys(xc.counts.byCategory).join(', '))})——已分类披露,非坐标冲突</div>`
      : '',
    xc && !xc.checked
      ? `<div style="padding:10px 22px;color:#6b7280;font-weight:600">· 交叉核对未执行:${escapeHtml(xc.secondaryUnavailable)}</div>`
      : '',
    receipt.deliveredUnverified
      ? `<div style="padding:10px 22px;color:#dc2626;font-weight:600">⚠ 本图是在 verify 未通过的情况下强制交付的(--allow-unverified)</div>`
      : '',
    receipt.ok
      ? ''
      : `<div style="padding:10px 22px;color:#dc2626;font-weight:600">⚠ 未通过 verify 门禁:${escapeHtml(verifyFailureReason(receipt))}</div>`,
  ].join('');
  const htmlWithBanner = banners ? html.replace('<main>', `<main>${banners}`) : html;
  // GitHub-sourced projects: the exported SVG's nodes are permalinks to the
  // exact source line. The interactive viewer stays unlinked (its evidence
  // panel already carries the URLs) so links don't hijack panel clicks.
  const gh = spec.meta?.project?.github || null;
  const exportLinks = gh
    ? new Map((spec.nodes || []).map((n) => [n.id, githubBlobUrl(gh, n.file, n.line)]))
    : null;
  const { svg: svgLinked } = renderTopologySvg(spec, { receipt, links: exportLinks });
  const svgStandalone = `<?xml version="1.0" encoding="UTF-8"?>\n${svgLinked.replace('>', `>\n<style>${svgExportStyle()}</style>`)}`;
  const wiki = buildWikiMarkdown({ spec, receipt, svgFile: path.basename(svgFile), baseName });

  atomicWrite(htmlFile, htmlWithBanner);
  atomicWrite(svgFile, svgStandalone);
  atomicWrite(wikiFile, wiki);
  atomicWrite(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);

  const deliverReceipt = {
    ok: true,
    verified: receipt.ok,
    artifacts: {
      html: { path: htmlFile, sha256: sha256Hex(htmlWithBanner), bytes: Buffer.byteLength(htmlWithBanner) },
      svg: { path: svgFile, sha256: sha256Hex(svgStandalone), bytes: Buffer.byteLength(svgStandalone) },
      wiki: { path: wikiFile, sha256: sha256Hex(wiki), bytes: Buffer.byteLength(wiki) },
      receipt: { path: receiptFile },
    },
    verify: { metrics: receipt.metrics, scannedAt: receipt.scannedAt },
    provenance: receipt.provenance,
    backendOverride: receipt.backendOverride,
    deliveredUnverified: receipt.deliveredUnverified === true,
    crossCheck: receipt.crossCheck ?? null,
  };
  if (flags['--json']) emitJson(deliverReceipt);
  else process.stderr.write(`delivered: ${htmlFile} + ${svgFile} + ${wikiFile} + receipt (risk ${(receipt.metrics.hallucinationRisk * 100).toFixed(2)}%)\n`);
  return 0;
}

function cmdDoctor(flags) {
  const nodeOk = process.version >= 'v18';
  const fixture = path.join(skillRoot, 'examples', 'fixture', 'rtl');
  let fixtureOk = false;
  let fixtureStats = null;
  try {
    const bundle = scanRtl(fixture);
    fixtureStats = bundle.stats;
    fixtureOk = bundle.stats.modules >= 5;
  } catch { /* reported below */ }
  // Backend report is advisory: a missing/too-old RTLens is a degraded but
  // supported configuration, so it must not fail the environment check.
  const probe = probeRtlens({});
  const backend = {
    requested: flags['--backend'] ?? 'auto',
    rtlens: {
      available: probe.available,
      version: probe.version,
      requiredVersion: probe.requiredVersion,
      python: probe.python,
      pkgRoot: probe.pkgRoot,
      source: probe.source,
      reason: probe.reason,
    },
    builtin: { available: true, scanner: 'scan-rtl' },
    effective: probe.available ? 'rtlens' : 'builtin',
    degraded: !probe.available,
  };
  const report = {
    ok: nodeOk && fixtureOk,
    node: process.version,
    scanner: 'scan-rtl',
    fixture: { path: fixture, ok: fixtureOk, stats: fixtureStats },
    backend,
  };
  if (flags['--json']) emitJson(report);
  else {
    process.stderr.write(`doctor: ${report.ok ? 'OK' : 'FAIL'} (node ${process.version}, fixture ${fixtureOk ? 'scans' : 'broken'})\n`);
    process.stderr.write(`backend: rtlens ${probe.available ? `available (${probe.version})` : 'unavailable'} — ${probe.reason}\n`);
  }
  return report.ok ? 0 : 1;
}

function cmdDemo([outDir], flags) {
  if (!outDir) usage();
  const fixture = path.join(skillRoot, 'examples', 'fixture', 'rtl');
  fs.mkdirSync(outDir, { recursive: true });
  const bundleFile = path.join(outDir, 'demo.bundle.json');
  const specFile = path.join(outDir, 'demo.topology.json');
  // Same backend selection as `scan`, so a demo on a machine with RTLens
  // installed exercises the index-evidence path end to end.
  const { bundle, provenance } = resolveBackendOrExit(fixture, flags);
  atomicWrite(bundleFile, `${JSON.stringify(bundle, null, 2)}\n`);
  const spec = deriveSpec(bundle, { title: 'HSB mini 拓扑(demo)', projectName: 'hsb-fixture' });
  atomicWrite(specFile, `${JSON.stringify(spec, null, 2)}\n`);
  // Deliver through the same code path (human output on stderr so --json
  // stdout stays a single parseable document).
  const code = cmdDeliver([specFile], { '--out': path.join(outDir, 'demo') });
  writeDegradedWarning(provenance);
  if (flags['--json']) {
    emitJson({ ok: code === 0, outDir, bundle: bundleFile, spec: specFile, exit: code, provenance });
  } else {
    process.stderr.write(`demo artifacts in ${outDir}\n`);
  }
  return code;
}

async function cmdSearch([query], flags) {
  if (!query) usage();
  const limit = Number(flags['--limit'] || 8);
  try {
    const repos = await searchRepos(query, limit);
    if (flags['--json']) emitJson({ ok: true, query, count: repos.length, repos });
    else {
      for (const r of repos) {
        process.stderr.write(`${r.slug} ★${r.stars} [${r.language}] (${r.defaultBranch}) — ${r.description || ''}\n`);
      }
      process.stderr.write(`\nnext: hw-topo gh <owner/repo>\n`);
    }
    return 0;
  } catch (error) {
    process.stderr.write(`search failed: ${error.message}\n`);
    return 2;
  }
}

async function cmdGh([slug], flags) {
  if (!slug || !/^[\w.-]+\/[\w.-]+$/.test(slug)) {
    process.stderr.write(`gh: expected <owner/repo>, got "${slug || ''}"\n`);
    return 2;
  }
  const outDir = path.resolve(flags['--out'] || slug.replace('/', '-'));
  const cacheRoot = path.join(outDir, '.gh-cache');
  try {
    let ref = flags['--ref'] || null;
    let sha = null;
    let pinned = true;
    try {
      const meta = await repoMeta(slug);
      ref = ref || meta.default_branch || 'main';
      sha = await resolveCommit(slug, ref);
    } catch (error) {
      if (!/rate limited/.test(error.message)) throw error;
      // API-free fallback: pin by branch name through the github.com archive
      // path. Links stay branch-pinned (mutable) instead of commit-pinned.
      ref = ref || 'main';
      sha = ref;
      pinned = false;
      process.stderr.write(`gh: API rate-limited; falling back to branch-pinned download (links not immutable)\n`);
    }
    const cacheDir = path.join(cacheRoot, `${slug.split('/')[1]}-${String(sha).slice(0, 12)}`);
    let tarballSha256 = null;
    let cached = fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).length > 0;
    if (!cached) {
      const { buffer, sha256 } = await downloadTarball(slug, sha);
      tarballSha256 = sha256;
      fs.rmSync(cacheDir, { recursive: true, force: true });
      const files = extractTarGz(buffer, cacheDir);
      if (files === 0) {
        process.stderr.write(`gh: tarball contained no extractable files\n`);
        return 2;
      }
      cached = false;
    }

    // Same backend selection as `scan`: a downloaded repo is scanned through
    // resolveBackend so provenance travels with the artifact (contract R5/R6).
    const { bundle, provenance } = resolveBackendOrExit(cacheDir, flags);
    if (bundle.stats.modules === 0) {
      process.stderr.write(`gh: no Verilog/SystemVerilog modules found in ${slug} (files scanned: ${bundle.stats.files})\n`);
      if (flags['--json']) emitJson({ ok: false, slug, sha, reason: 'no-rtl', scannedFiles: bundle.stats.files });
      return 2;
    }
    writeDegradedWarning(provenance);
    const spec = deriveSpec(bundle, {
      focus: flags['--focus'] || null,
      groupByDir: !flags['--no-groups'],
      title: flags['--title'] || `${slug} 拓扑`,
      projectName: slug,
    });
    spec.meta.project.github = { slug, ref, sha, tarballSha256, pinned };
    const specFile = path.join(outDir, `${slug.split('/')[1]}.topology.json`);
    const bundleFile = path.join(outDir, `${slug.split('/')[1]}.bundle.json`);
    fs.mkdirSync(outDir, { recursive: true });
    atomicWrite(bundleFile, `${JSON.stringify(bundle, null, 2)}\n`);
    atomicWrite(specFile, `${JSON.stringify(spec, null, 2)}\n`);

    // Deliver through the same backend the bundle came from: pass the backend
    // flags down so a forced `--backend/--rtlens-root/--evidence` is honoured
    // by verify as well (contract R5). Without this a gh run pinned to a
    // specific RTLens install would verify against whatever auto-discovery
    // finds instead.
    const code = cmdDeliver([specFile], {
      '--out': path.join(outDir, slug.split('/')[1]),
      '--backend': flags['--backend'],
      '--rtlens-root': flags['--rtlens-root'],
      '--evidence': flags['--evidence'],
      '--define': flags['--define'],
    });
    if (code === 0 && flags['--json']) {
      emitJson({ ok: true, slug, ref, sha, pinned, cacheDir, cached, spec: specFile, stats: bundle.stats, provenance });
    } else if (flags['--json']) {
      emitJson({ ok: false, slug, sha, exit: code });
    } else {
      process.stderr.write(`gh: ${slug}@${sha.slice(0, 10)} -> ${outDir} (source cached at ${cacheDir})\n`);
    }
    return code;
  } catch (error) {
    process.stderr.write(`gh failed: ${error.message}\n`);
    return 2;
  }
}

const [command, ...rest] = process.argv.slice(2);
if (!command) usage();
const { positional, flags } = parseArgs(rest);
let exit = 2;
if (command === 'scan') exit = cmdScan(positional, flags);
else if (command === 'derive') exit = cmdDerive(positional, flags);
else if (command === 'validate') exit = cmdValidate(positional, flags);
else if (command === 'verify') exit = cmdVerify(positional, flags);
else if (command === 'deliver') exit = cmdDeliver(positional, flags);
else if (command === 'doctor') exit = cmdDoctor(flags);
else if (command === 'demo') exit = cmdDemo(positional, flags);
else if (command === 'search') exit = await cmdSearch(positional, flags);
else if (command === 'gh') exit = await cmdGh(positional, flags);
else usage();
// Network commands: give undici a beat to close sockets before exit, else
// Windows libuv asserts on a closing handle (stderr noise only).
if (command === 'search' || command === 'gh') setTimeout(() => process.exit(exit), 50);
else process.exit(exit);
