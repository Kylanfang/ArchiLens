// RTLens evidence backend: probe the external indexer, run it, and fall back
// to hw-topo's built-in scanner when it is not usable.
//
// Contract reference: docs/EVIDENCE_CONTRACT.md §4 (provenance) and §5
// (version/compatibility — the `evidence` subcommand lands in rtlens 6.2.0).
//
// Two rules this file exists to enforce:
//   R5 — `scan` and `verify` must use the SAME backend, so the backend
//        identity travels with the bundle in `provenance`.
//   R6 — degradation must be explicit: `degraded: true` plus a human reason,
//        never a silent fallback. `--backend rtlens` never degrades; it throws.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { scanRtl } from './scan-rtl.mjs';
import { evidenceToBundle, EVIDENCE_SCHEMA, BUNDLE_SCHEMA_ID } from './evidence-adapter.mjs';
import { parseJson } from './util.mjs';

export { EVIDENCE_SCHEMA, BUNDLE_SCHEMA_ID };

/** Minimum rtlens version that ships `rtlens evidence`. */
export const MIN_RTLENS_VERSION = '6.2.0';

/** npm identity of the packaged RTLens plugin. */
const RTLENS_IDENTITY = 'rtlens-dsh/package.json';

const PROBE_TIMEOUT_MS = 20000;
const VERSION_TIMEOUT_MS = 20000;
const EVIDENCE_TIMEOUT_MS = 300000;
const EVIDENCE_MAX_BUFFER = 256 * 1024 * 1024;

const here = path.dirname(fileURLToPath(import.meta.url));
/** .../<plugin>/hw-topo/lib -> .../<plugin> */
const skillRoot = path.resolve(here, '..');

/** Parse `rtlens v6.2.0` (also tolerates `rtlens 6.2.0`, `v6.2.0`, `6.2.0`). */
export function parseRtlensVersion(output) {
  if (typeof output !== 'string') return null;
  const m = output.match(/\bv?(\d+)\.(\d+)\.(\d+)\b/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Compare dotted numeric versions. Returns <0, 0 or >0. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Every candidate root for the RTLens package, in contract order, plus the
 * label used to explain the hit to the user.
 *
 *   1. opts.pkgRoot / $HW_TOPO_RTLENS_ROOT / $RTLENS_HOME
 *   2. require.resolve('rtlens-dsh/package.json') anchored at process.cwd()
 *   3. walking up from the skill root through node_modules/
 *   4. $DSH_HOME/profiles/<profile>/node_modules/rtlens-dsh/package.json
 */
export function discoverRtlensRoots(opts = {}) {
  const candidates = [];
  // `level` encodes AUTHORITY, not preference:
  //   0 = named for this call (`--rtlens-root` / opts.pkgRoot)
  //   1 = named for the environment ($HW_TOPO_RTLENS_ROOT / $RTLENS_HOME)
  //   2 = discovered automatically
  // A lower level always wins over a higher one (see probeRtlensUncached).
  const push = (root, source, level = 2) => {
    if (typeof root !== 'string' || !root) return;
    const resolved = path.resolve(root);
    if (candidates.some((c) => path.resolve(c.root) === resolved)) return;
    candidates.push({ root: resolved, source, level, explicit: level < 2 });
  };

  // 1. named roots — authoritative, see probeRtlensUncached
  push(opts.pkgRoot, 'opts.pkgRoot', 0);
  push(process.env.HW_TOPO_RTLENS_ROOT, 'env HW_TOPO_RTLENS_ROOT', 1);
  push(process.env.RTLENS_HOME, 'env RTLENS_HOME', 1);

  // 2. node resolution from the current working directory
  try {
    const require = createRequire(path.join(process.cwd(), 'noop.cjs'));
    push(path.dirname(require.resolve(RTLENS_IDENTITY)), `require.resolve('${RTLENS_IDENTITY}') from cwd`);
  } catch { /* not resolvable from cwd — fall through */ }

  // 3. walk up from the skill root, checking node_modules at each level
  let dir = skillRoot;
  for (;;) {
    push(path.join(dir, 'node_modules', 'rtlens-dsh'), `node_modules walk from ${dir}`);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 4. every DSH profile (skipped entirely when DSH_HOME is unset)
  const dshHome = process.env.DSH_HOME;
  if (dshHome) {
    const profilesDir = path.join(dshHome, 'profiles');
    try {
      for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
        if (entry.isDirectory()) push(path.join(profilesDir, entry.name, 'node_modules', 'rtlens-dsh'), `DSH profile ${entry.name}`);
      }
    } catch { /* no profiles dir — skip */ }
  }

  return candidates;
}

/** A discovered root counts only when its package.json exists. */
function candidateWithManifest(candidate) {
  const manifest = path.join(candidate.root, 'package.json');
  if (!fs.existsSync(manifest)) return null;
  let pkg = null;
  try { pkg = parseJson(fs.readFileSync(manifest, 'utf8')); } catch { return null; }
  return { ...candidate, manifest, pkg };
}

/**
 * Candidate python interpreters, in order: opts.python, $HW_TOPO_PYTHON,
 * `python`, `python3`, `py -3`. On Windows `python` is the common spelling.
 * Each entry is argv (so `py -3` works as a two-element command).
 */
export function pythonCandidates(opts = {}) {
  const list = [];
  const push = (argv, source) => {
    if (!argv || !argv.length) return;
    if (list.some((c) => c.argv.join(' ') === argv.join(' '))) return;
    list.push({ argv, source });
  };
  if (typeof opts.python === 'string' && opts.python) push([opts.python], 'opts.python');
  else if (Array.isArray(opts.python) && opts.python.length) push(opts.python, 'opts.python');
  if (process.env.HW_TOPO_PYTHON) push([process.env.HW_TOPO_PYTHON], 'env HW_TOPO_PYTHON');
  push(['python'], 'PATH');
  push(['python3'], 'PATH');
  push(['py', '-3'], 'PATH');
  return list;
}

function runSync(argv, opts = {}) {
  return spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    timeout: opts.timeout ?? PROBE_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer ?? 1024 * 1024,
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    windowsHide: true,
    shell: false,
  });
}

/**
 * Working directories that can import the `rtlens` python package. The npm
 * bundle keeps it at <pkgRoot>/rtlens; from the RTLens source checkout
 * <pkgRoot>/rtlens and <pkgRoot>/lsP/rtlens both work. First hit wins, and
 * the winner is reused by runRtlensEvidence.
 */
function pythonCwdCandidates(pkgRoot) {
  return [
    pkgRoot,
    path.join(pkgRoot, 'rtlens'),
    path.join(pkgRoot, 'lsP', 'rtlens'),
    skillRoot,
  ].filter((dir, i, all) => all.indexOf(dir) === i && fs.existsSync(dir));
}

/**
 * Run `<python> -m rtlens --version` in the first cwd that actually imports
 * the `rtlens` package. Directories that hold an importable `rtlens/` package
 * are tried first so a normal install costs one python call.
 */
function probeVersion(candidate, pkgRoot) {
  const all = pythonCwdCandidates(pkgRoot);
  const importable = all.filter((dir) => fs.existsSync(path.join(dir, 'rtlens', '__init__.py')));
  const order = [...importable, ...all.filter((dir) => !importable.includes(dir))];
  let lastStderr = '';
  for (const cwd of order) {
    const r = runSync([...candidate.argv, '-m', 'rtlens', '--version'], { cwd, timeout: VERSION_TIMEOUT_MS });
    if (r.error) return { error: r.error, cwd };
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status === 0) {
      return { version: parseRtlensVersion(out), raw: out.trim(), cwd };
    }
    // A non-zero exit means the module was not importable here; try the next
    // cwd, but remember the message for the failure report.
    lastStderr = (r.stderr || '').trim() || lastStderr;
  }
  return { version: null, raw: lastStderr.slice(0, 300) };
}

/**
 * Cached probe result, keyed by every input that can change the answer.
 * Failures are cached too, so one run never pays the interpreter timeout
 * twice (doctor + scan + verify all probe).
 */
const probeCache = new Map();

/**
 * Probe for a usable RTLens evidence backend. Never throws: every failure is
 * reported as `available: false` with a human-readable `reason`.
 *
 * Set `HW_TOPO_DEBUG_BACKEND=1` to trace candidate discovery on stderr.
 *
 * @param {{pkgRoot?: string, python?: string}} [opts]
 * @returns {{available: boolean, reason: string, python: string|null,
 *            pkgRoot: string|null, version: string|null, source: string|null,
 *            requiredVersion: string}}
 */
export function probeRtlens(opts = {}) {
  const key = `${opts.pkgRoot ?? ''}|${opts.python ?? ''}|${process.env.HW_TOPO_RTLENS_ROOT ?? ''}|${process.env.RTLENS_HOME ?? ''}|${process.env.DSH_HOME ?? ''}`;
  const cached = probeCache.get(key);
  if (cached) return cached;

  const result = probeRtlensUncached(opts);
  probeCache.set(key, result);
  return result;
}

function probeRtlensUncached(opts) {
  const requiredVersion = MIN_RTLENS_VERSION;
  const fail = (reason, extra = {}) => ({
    available: false, reason, python: null, pkgRoot: null, version: null, source: null, requiredVersion, ...extra,
  });

  const discovered = discoverRtlensRoots(opts);
  // Authority beats convenience, in this order:
  //   1. a root named for THIS call (`--rtlens-root`) — if the caller names one,
  //      quietly using any other copy would be the exact silent substitution
  //      this project exists to prevent, and a typo in the flag would be
  //      invisible;
  //   2. a root named for the ENVIRONMENT ($HW_TOPO_RTLENS_ROOT/$RTLENS_HOME)
  //      — a deliberate default, but still overridable by the flag;
  //   3. auto-discovery — only here do we prefer the newest usable install.
  const named = discovered.filter((c) => c.level < 2);
  const pool = named.length > 0
    ? named.filter((c) => c.level === Math.min(...named.map((n) => n.level)))
    : discovered;
  const candidates = pool.map(candidateWithManifest).filter(Boolean);
  if (process.env.HW_TOPO_DEBUG_BACKEND) {
    process.stderr.write(`[rtlens-backend] candidates (${named.length > 0 ? `named level ${pool[0]?.level}` : 'discovered'}): ${JSON.stringify(candidates.map((c) => [c.root, c.source]))}\n`);
  }
  if (candidates.length === 0) {
    if (named.length > 0) {
      return fail(
        `explicitly requested rtlens root ${pool[0].root} (${pool[0].source}) is not a usable ${RTLENS_IDENTITY} package: no package.json at ${path.join(pool[0].root, 'package.json')}`,
        { pkgRoot: pool[0].root, source: pool[0].source },
      );
    }
    return fail(`rtlens package not found (looked for ${RTLENS_IDENTITY} via opts.pkgRoot, HW_TOPO_RTLENS_ROOT, RTLENS_HOME, require.resolve from cwd, node_modules walk from ${skillRoot}, and DSH_HOME profiles)`);
  }

  let lastPythonError = null;
  // Keep the first *identified* rtlens that is merely too old: if no later
  // candidate is new enough, "too old" is the most useful thing to report.
  let tooOld = null;
  for (const candidate of candidates) {
    for (const py of pythonCandidates(opts)) {
      const probe = probeVersion(py, candidate.root);
      if (process.env.HW_TOPO_DEBUG_BACKEND) {
        process.stderr.write(`[rtlens-backend] try ${py.argv.join(' ')} @ ${candidate.root} -> ${probe.error ? `error ${probe.error.message}` : `version ${JSON.stringify(probe.version)} cwd ${probe.cwd}`}\n`);
      }
      if (probe.error) {
        // Interpreter itself is unusable (ENOENT / timeout) — next candidate.
        lastPythonError = `${py.argv.join(' ')} (${py.source}) could not run: ${probe.error.message}`;
        continue;
      }
      const version = probe.version ?? candidate.pkg.version ?? null;
      if (!version) {
        lastPythonError = `${py.argv.join(' ')} -m rtlens --version produced no version${probe.raw ? ` (${probe.raw})` : ''}`;
        continue;
      }
      if (compareVersions(version, requiredVersion) < 0) {
        // Too old to be usable, but a later candidate may be new enough, so
        // remember it and keep looking.
        if (!tooOld) {
          tooOld = {
            available: false,
            reason: `rtlens ${version} at ${candidate.root} (${candidate.source}) is too old: the evidence backend requires >= ${requiredVersion}`,
            python: py.argv.join(' '),
            pythonArgv: py.argv,
            pkgRoot: candidate.root,
            pythonCwd: probe.cwd,
            version,
            packageVersion: candidate.pkg?.version ?? null,
            source: candidate.source,
            requiredVersion,
          };
        }
        continue;
      }
      return {
        available: true,
        reason: `rtlens ${version} via ${py.argv.join(' ')} (package at ${candidate.root}, ${candidate.source})`,
        python: py.argv.join(' '),
        pythonArgv: py.argv,
        pkgRoot: candidate.root,
        pythonCwd: probe.cwd,
        version,
        packageVersion: candidate.pkg?.version ?? null,
        source: candidate.source,
        requiredVersion,
      };
    }
  }

  if (tooOld) return tooOld;

  return {
    available: false,
    reason: lastPythonError
      ? `rtlens found at ${candidates[0].root} but no usable python interpreter: ${lastPythonError}`
      : `rtlens found at ${candidates[0].root} but no python interpreter could import it`,
    python: null,
    pkgRoot: candidates[0].root,
    version: candidates[0].pkg?.version ?? null,
    source: candidates[0].source,
    requiredVersion,
  };
}

/**
 * Run `python -m rtlens evidence <root> --json [-D NAME]...` and return the
 * parsed evidence document. Throws on any failure (with a stderr excerpt) —
 * the caller decides whether to degrade.
 *
 * @param {{root: string, pkgRoot?: string, python?: string, defines?: string[],
 *          includePaths?: string[], maxFiles?: number, maxSignals?: number,
 *          maxConnections?: number, timeoutMs?: number, allowOldVersion?: boolean}} opts
 * @returns {object} parsed `rtlens.evidence/1`
 */
export function runRtlensEvidence(opts = {}) {
  const root = opts.root;
  if (!root) throw new Error('runRtlensEvidence: root is required');
  const probe = opts.probe ?? probeRtlens(opts);
  if (!probe.available) throw new Error(`runRtlensEvidence: rtlens unavailable — ${probe.reason}`);

  const argv = [...(probe.pythonArgv ?? probe.python.split(' ')), '-m', 'rtlens', 'evidence', path.resolve(root), '--json'];
  for (const define of opts.defines || []) {
    if (define) argv.push('-D', String(define));
  }
  // Passthrough caps. These change what the evidence CONTAINS, so they are
  // forwarded verbatim and never invented: a wrong value must fail loudly in
  // rtlens (argparse, exit 2) rather than be quietly corrected here.
  for (const inc of opts.includePaths || []) {
    if (inc) argv.push('-I', String(inc));
  }
  if (Number.isInteger(opts.maxFiles)) argv.push('--max-files', String(opts.maxFiles));
  if (Number.isInteger(opts.maxSignals)) argv.push('--max-signals', String(opts.maxSignals));
  if (Number.isInteger(opts.maxConnections)) argv.push('--max-connections', String(opts.maxConnections));
  const r = runSync(argv, {
    cwd: probe.pythonCwd ?? probe.pkgRoot,
    timeout: opts.timeoutMs ?? EVIDENCE_TIMEOUT_MS,
    maxBuffer: EVIDENCE_MAX_BUFFER,
  });
  if (r.error) throw new Error(`rtlens evidence failed to start: ${r.error.message}`);
  if (r.status !== 0) {
    const err = (r.stderr || '').trim().split('\n').slice(-6).join('\n');
    throw new Error(`rtlens evidence exited ${r.status}${err ? `: ${err}` : ''}`);
  }
  let parsed;
  try {
    parsed = parseJson(r.stdout);
  } catch (error) {
    throw new Error(`rtlens evidence did not emit JSON on stdout (${error.message}); first bytes: ${String(r.stdout).slice(0, 200)}`);
  }
  return parsed;
}

/**
 * Reconcile the define set: what we asked for vs what the document reports.
 *
 * The document is authoritative about what it actually used — but an EMPTY or
 * missing echo must never erase a define we requested, because that drops a
 * scan parameter silently (found for real: a producer that ignores `-D` made
 * `-D SIM` vanish from provenance while the scan stayed "successful").
 * When both sides speak and disagree, keep both: the disagreement is data.
 */
function applyDefines(bundle, evidence, defines) {
  const requested = Object.fromEntries((defines || []).filter(Boolean).map((d) => [d, '1']));
  const echoed = evidence.defines && typeof evidence.defines === 'object' ? evidence.defines : null;
  if (echoed && Object.keys(echoed).length > 0) bundle.provenance.defines = echoed;
  else if (Object.keys(requested).length > 0) bundle.provenance.defines = requested;
  if (echoed && Object.keys(echoed).length > 0
      && JSON.stringify(echoed) !== JSON.stringify(requested)) {
    bundle.provenance.definesRequested = requested;
  }
}

/** Only the content-changing evidence options, and only those actually given. */
function rtlensRunOptions(opts) {
  return {
    includePaths: opts.includePaths,
    maxFiles: opts.maxFiles,
    maxSignals: opts.maxSignals,
    maxConnections: opts.maxConnections,
  };
}

/**
 * Record the content-changing options in provenance.
 * The *effect* of a cap is already explicit (`diagnostics.*Truncated*`), but a
 * bundle must also be reproducible: "same command, same result" requires the
 * command, and a default is not worth recording because it is not a decision.
 */
function recordBackendOptions(bundle, opts) {
  const recorded = {};
  if (Array.isArray(opts.includePaths) && opts.includePaths.length) recorded.includePaths = [...opts.includePaths];
  if (Number.isInteger(opts.maxFiles)) recorded.maxFiles = opts.maxFiles;
  if (Number.isInteger(opts.maxSignals)) recorded.maxSignals = opts.maxSignals;
  if (Number.isInteger(opts.maxConnections)) recorded.maxConnections = opts.maxConnections;
  if (Object.keys(recorded).length) bundle.provenance.backendOptions = recorded;
}

/** Build a provenance block (§4) from a probe result. */function toolProvenance(tool, version) {
  return { name: tool, version: version ?? null };
}

const BUILTIN_PROVENANCE = (reason, extra = {}) => ({
  backend: 'builtin',
  degraded: true,
  reason,
  evidenceSchema: null,
  tool: toolProvenance('hw-topo scan-rtl', null),
  defines: {},
  rootAbs: null,
  ...extra,
});

/**
 * Single entry point used by scan / derive / verify / deliver / gh.
 *
 *   backend 'rtlens'  -> force RTLens; unavailable is a hard error (exit 2).
 *   backend 'builtin' -> force the internal scanner. Explicitly choosing the
 *                        lower evidence grade is still recorded as degraded
 *                        (R6: the artefact must say which grade it used).
 *   backend 'auto'    -> prefer RTLens, fall back with degraded:true + reason.
 *
 * `opts.evidenceFile` bypasses both and transcribes a saved evidence JSON
 * (what `--evidence` does); the transcription is validated exactly as if it
 * had just come off the wire.
 *
 * @param {string} root RTL root to scan (or the root the evidence was made from)
 * @param {{backend?: string, evidenceFile?: string, defines?: string[],
 *          bundlePath?: string, pkgRoot?: string, python?: string,
 *          maxFiles?: number}} [opts]
 * @returns {{bundle: object, provenance: object, backend: string,
 *            degraded: boolean, reason: string|null, scanned: boolean, out?: string}}
 */
export function resolveBackend(root, opts = {}) {
  const backend = opts.backend ?? 'auto';
  if (!['auto', 'rtlens', 'builtin'].includes(backend)) {
    throw new Error(`resolveBackend: unknown backend "${backend}" (expected auto | rtlens | builtin)`);
  }
  const defines = opts.defines || [];

  // --evidence <file>: transcribe a saved rtlens evidence document.
  if (opts.evidenceFile) {
    let evidence;
    try {
      evidence = parseJson(fs.readFileSync(opts.evidenceFile, 'utf8'));
    } catch (error) {
      throw new Error(`cannot read evidence file ${opts.evidenceFile}: ${error.message}`);
    }
    const bundle = evidenceToBundle(evidence, {
      root,
      defines: Object.fromEntries(defines.map((d) => [d, '1'])),
      evidenceFile: path.resolve(opts.evidenceFile),
    });
    const provenance = bundle.provenance;
    return { bundle, provenance, backend: provenance.backend, degraded: provenance.degraded, reason: provenance.reason, scanned: true, out: root };
  }

  if (backend === 'rtlens') {
    const probe = probeRtlens({ pkgRoot: opts.pkgRoot, python: opts.python });
    if (!probe.available) {
      throw new Error(`--backend rtlens requested but rtlens is unavailable: ${probe.reason}`);
    }
    const evidence = runRtlensEvidence({ root, defines, probe, ...rtlensRunOptions(opts) });
    const bundle = evidenceToBundle(evidence, { root });
    applyDefines(bundle, evidence, defines);
    recordBackendOptions(bundle, opts);
    return { bundle, provenance: bundle.provenance, backend: 'rtlens', degraded: false, reason: null, scanned: true, out: root, probe };
  }

  if (backend === 'auto') {
    const probe = probeRtlens({ pkgRoot: opts.pkgRoot, python: opts.python });
    if (probe.available) {
      try {
        const evidence = runRtlensEvidence({ root, defines, probe, ...rtlensRunOptions(opts) });
        const bundle = evidenceToBundle(evidence, { root });
        applyDefines(bundle, evidence, defines);
        recordBackendOptions(bundle, opts);
        return { bundle, provenance: bundle.provenance, backend: 'rtlens', degraded: false, reason: null, scanned: true, out: root, probe };
      } catch (error) {
        // rtlens was present but the run failed: degrade visibly (R6).
        const reason = `rtlens evidence failed: ${error.message}`;
        const bundle = scanRtl(root, { maxFiles: opts.maxFiles });
        bundle.provenance = BUILTIN_PROVENANCE(reason, { defines: Object.fromEntries(defines.map((d) => [d, '1'])) });
        return { bundle, provenance: bundle.provenance, backend: 'builtin', degraded: true, reason, scanned: true, out: root, probe };
      }
    }
    const reason = `rtlens unavailable: ${probe.reason}`;
    const bundle = scanRtl(root, { maxFiles: opts.maxFiles });
    bundle.provenance = BUILTIN_PROVENANCE(reason, { defines: Object.fromEntries(defines.map((d) => [d, '1'])) });
    return { bundle, provenance: bundle.provenance, backend: 'builtin', degraded: true, reason, scanned: true, out: root, probe };
  }

  // backend === 'builtin'
  const reason = opts.reason ?? 'backend builtin requested explicitly (builtin regex scanner, not RTLens index evidence)';
  const bundle = scanRtl(root, { maxFiles: opts.maxFiles });
  bundle.provenance = BUILTIN_PROVENANCE(reason, { defines: Object.fromEntries(defines.map((d) => [d, '1'])) });
  return { bundle, provenance: bundle.provenance, backend: 'builtin', degraded: true, reason, scanned: true, out: root };
}

/** Attach provenance to a bundle that was read from disk without one. */
export function provenanceOf(bundle) {
  return bundle?.provenance ?? null;
}
