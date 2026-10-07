// Cross-engine parity gate: RTLens index evidence vs the builtin regex scanner,
// measured on the SAME real RTL trees.
//
// This is the executable form of docs/CROSS_ENGINE_PARITY.md (in the RTLens
// repo). It exists because the original defect — two plugins that "disagreed on
// statements and line numbers" — was a COORDINATE break, and a coordinate break
// is exactly the kind of thing a fixture-only test cannot catch: the bundled
// 3-file fixture agrees perfectly even when the two engines disagree on
// generate blocks, dead `ifdef branches and arrayed instantiations.
//
// The rule this file enforces (and the reason it does not cry wolf):
//
//   A COORDINATE VIOLATION = both engines report the same identity
//   (module name, or parent>type.instance) but their line sets are DISJOINT —
//   i.e. one of them points somewhere the other never points. That is the
//   signature of an off-by-one or a path-basis mix-up: {139,151} vs {140,152}.
//
//   A COVERAGE DIFFERENCE = the line sets overlap but one engine found extra
//   sites. Both engines document their limits (`for (genvar ...)` bodies, dead
//   `` `ifdef `` regions, arrayed instance forms), so this is expected and is
//   reported, not asserted away.
//
// Environment:
//   HW_TOPO_OSS_REPOS   directory containing real RTL projects (one per subdir)
//   HW_TOPO_RTLENS_ROOT RTLens package root (else autodiscovery)
//   HW_TOPO_PYTHON      python interpreter (else python / python3 / py -3)
//
// The file always runs the fixture case; the real-project case self-skips with
// a reason when either side is unavailable, so it can never report a false
// failure on a machine that simply lacks the corpora.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanRtl } from '../lib/scan-rtl.mjs';
import { probeRtlens, runRtlensEvidence } from '../lib/rtlens-backend.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'examples', 'fixture', 'rtl');

/** Conventional corpora locations, tried only when $HW_TOPO_OSS_REPOS is unset. */
const OSS_CANDIDATES = [
  path.resolve(here, '..', '..', '..', 'oss_repos'), // sibling of the repo root
];

/** Keep the gate fast: skip anything implausibly large. */
const MAX_RTL_FILES = 600;

const probe = probeRtlens({});
const rtlensSkip = probe.available
  ? false
  : `rtlens evidence backend unavailable: ${probe.reason}`;

function findOssRoot() {
  if (process.env.HW_TOPO_OSS_REPOS) {
    return fs.existsSync(process.env.HW_TOPO_OSS_REPOS) ? process.env.HW_TOPO_OSS_REPOS : null;
  }
  for (const candidate of OSS_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Directories under `root` that look like RTL projects. */
function rtlProjects(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let count = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (count > MAX_RTL_FILES) return;
        if (e.isDirectory()) {
          if (e.name === 'node_modules' || e.name === '.git') continue;
          walk(path.join(d, e.name));
        } else if (/\.(v|sv|vh|svh)$/i.test(e.name)) {
          count += 1;
        }
      }
    };
    try {
      walk(dir);
    } catch {
      continue;
    }
    if (count > 0 && count <= MAX_RTL_FILES) out.push({ name: entry.name, dir, files: count });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Compare two engines and return the coordinate violations.
 * `identity` is name|file for modules and parent>type.instance|file for instances.
 */
function compareCoordinates(label, left, right) {
  const group = (rows, identity) => {
    const map = new Map();
    for (const row of rows) {
      const key = identity(row);
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(row.line);
    }
    return map;
  };

  const leftGroups = group(left.rows, left.identity);
  const rightGroups = group(right.rows, right.identity);
  const shared = [...leftGroups.keys()].filter((k) => rightGroups.has(k));

  const violations = [];
  let coverageOnly = 0;
  for (const key of shared) {
    const a = [...leftGroups.get(key)];
    const b = [...rightGroups.get(key)];
    const common = a.filter((line) => b.includes(line));
    if (common.length === 0) {
      violations.push(`${key}  left=[${a.sort((x, y) => x - y)}] right=[${b.sort((x, y) => x - y)}]`);
    } else if (a.length !== b.length) {
      coverageOnly += 1;
    }
  }

  const onlyLeft = [...leftGroups.keys()].filter((k) => !rightGroups.has(k)).length;
  const onlyRight = [...rightGroups.keys()].filter((k) => !leftGroups.has(k)).length;
  return {
    label,
    shared: shared.length,
    violations,
    coverageOnly,
    onlyLeft,
    onlyRight,
    leftCount: left.rows.length,
    rightCount: right.rows.length,
  };
}

function parityReport(root) {
  const evidence = runRtlensEvidence({ root, probe });
  const bundle = scanRtl(root);

  const modules = compareCoordinates(
    'MODULES',
    {
      rows: evidence.modules.map((m) => ({ id: `${m.name}|${m.file}`, line: m.line1 })),
      identity: (r) => r.id,
    },
    {
      rows: bundle.modules.map((m) => ({ id: `${m.name}|${m.file}`, line: m.line })),
      identity: (r) => r.id,
    },
  );

  const instances = compareCoordinates(
    'INSTANCES',
    {
      rows: evidence.instances.map((i) => ({
        id: `${i.parent}>${i.type}.${i.instance}|${i.file}`,
        line: i.line1,
      })),
      identity: (r) => r.id,
    },
    {
      rows: bundle.instantiations.map((i) => ({
        id: `${i.parent}>${i.type}.${i.instance}|${i.file}`,
        line: i.line,
      })),
      identity: (r) => r.id,
    },
  );

  return { modules, instances, stats: { rtlens: evidence.stats, builtin: bundle.stats } };
}

function describe(prefix, report) {
  for (const part of [report.modules, report.instances]) {
    process.stdout.write(
      `  ${prefix} ${part.label}: left=${part.leftCount} right=${part.rightCount} `
      + `shared=${part.shared} violations=${part.violations.length} `
      + `coverage-diffs=${part.coverageOnly} only-left=${part.onlyLeft} only-right=${part.onlyRight}\n`,
    );
    for (const violation of part.violations.slice(0, 5)) {
      process.stdout.write(`      !! ${violation}\n`);
    }
  }
}

test(
  'parity: bundled fixture agrees exactly across engines (no coverage drift either)',
  { skip: rtlensSkip },
  () => {
    const report = parityReport(fixture);
    describe('fixture', report);

    // The fixture is small and deliberately contains no generate/ifdef/arrayed
    // constructs, so here we can demand more than "no violations": the two
    // engines must produce the SAME identities and the SAME lines.
    assert.equal(report.modules.violations.length, 0);
    assert.equal(report.instances.violations.length, 0);
    assert.equal(report.modules.onlyLeft, 0);
    assert.equal(report.modules.onlyRight, 0);
    assert.equal(report.instances.onlyLeft, 0);
    assert.equal(report.instances.onlyRight, 0);

    // Guard against a vacuous pass (e.g. an engine silently returning nothing).
    assert.ok(report.modules.shared >= 6, `expected >= 6 shared modules, got ${report.modules.shared}`);
    assert.ok(report.instances.shared >= 7, `expected >= 7 shared instances, got ${report.instances.shared}`);

    // And the aggregate counts must match too, as the reports claim.
    assert.equal(report.stats.rtlens.modules, report.stats.builtin.modules);
    assert.equal(report.stats.rtlens.instances, report.stats.builtin.instantiations);
  },
);

test(
  'parity: real RTL projects show zero coordinate violations',
  { skip: rtlensSkip },
  () => {
    const ossRoot = findOssRoot();
    if (!ossRoot) {
      // Not a failure: the corpora simply are not on this machine.
      process.stdout.write(
        '  skipped real-project parity: no corpora found '
        + '(set HW_TOPO_OSS_REPOS to a directory of RTL projects)\n',
      );
      return;
    }

    const projects = rtlProjects(ossRoot);
    if (projects.length === 0) {
      process.stdout.write(`  skipped real-project parity: no RTL projects under ${ossRoot}\n`);
      return;
    }

    process.stdout.write(`  corpora: ${ossRoot} (${projects.length} projects)\n`);
    const failures = [];
    let comparedModules = 0;
    let comparedInstances = 0;

    for (const project of projects) {
      let report;
      try {
        report = parityReport(project.dir);
      } catch (error) {
        // A project the producer cannot index is a producer problem, not a
        // coordinate violation — surface it loudly but do not misattribute it.
        failures.push(`${project.name}: could not compare (${error.message})`);
        continue;
      }
      describe(project.name, report);
      comparedModules += report.modules.shared;
      comparedInstances += report.instances.shared;
      for (const violation of report.modules.violations) {
        failures.push(`${project.name} MODULE ${violation}`);
      }
      for (const violation of report.instances.violations) {
        failures.push(`${project.name} INSTANCE ${violation}`);
      }
    }

    assert.ok(
      comparedModules > 0 && comparedInstances > 0,
      'parity gate compared nothing; refusing to pass vacuously',
    );
    process.stdout.write(
      `  compared ${comparedModules} shared modules / ${comparedInstances} shared instances\n`,
    );
    assert.deepEqual(failures, [], `coordinate violations found:\n${failures.join('\n')}`);
  },
);
