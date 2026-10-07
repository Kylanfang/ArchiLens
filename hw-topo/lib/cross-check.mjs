// Cross-engine divergence disclosure.
//
// Why this exists: hw-topo can build the same diagram from two independent
// implementations — the RTLens evidence backend, and the zero-dependency
// builtin regex scanner. The two are ALLOWED to differ in COVERAGE (each
// documents its own blind spots: the builtin scanner extracts instantiations
// from dead `ifdef regions and misses arrayed forms; RTLens skips bodies of
// `for (genvar ...)` generate loops). They must NEVER differ in COORDINATES,
// because two engines pointing at different lines for the same fact is the
// signature of an off-by-one or a path-basis mistake — precisely the
// "the two plugins disagree about line numbers" failure this integration was
// built to remove.
//
// So `--cross-check` runs BOTH engines and discloses the difference one
// divergence at a time, with a reason wherever the source text can supply one.
// Nothing is hidden and nothing is silently "reconciled": the primary engine's
// rows are what the diagram is built from; the secondary engine is only a
// witness, and it is reported as such.
//
// The classification relies on source heuristics (`dead-ifdef` and
// `generate-block` are read from the file text, not from a real preprocessor or
// elaborator), so the categories are disclosed as *explanations*, never used to
// suppress a divergence.
import fs from 'node:fs';
import path from 'node:path';

export const CROSS_CHECK_SCHEMA = 'hw-topo.crossCheck/1';

/** Divergence categories, from most to least alarming. */
export const CATEGORIES = {
  coordinateMismatch: 'coordinate-mismatch',
  deadIfdef: 'dead-ifdef',
  generateBlock: 'generate-block',
  arrayedForm: 'arrayed-form',
  coverageOnly: 'coverage-only',
};

/** Human-readable meaning of each category, surfaced in receipts and pages. */
export const CATEGORY_NOTES = {
  [CATEGORIES.coordinateMismatch]:
    'both engines report this fact but their line sets are disjoint — the signature of an off-by-one or a path-basis mistake, and the one category that can fail a strict verify',
  [CATEGORIES.deadIfdef]:
    'the reporting engine found it inside an `ifdef region whose macro is not defined, so the site is not actually compiled in (a phantom)',
  [CATEGORIES.generateBlock]:
    'the reporting engine found it inside a `for (genvar ...)` generate body, which the other engine does not scan (a coverage difference, not a disagreement)',
  [CATEGORIES.arrayedForm]:
    'the site uses an arrayed instantiation form, which the non-reporting engine does not recognise (a coverage difference)',
  [CATEGORIES.coverageOnly]:
    'the engines disagree about coverage here and the source text offers no further explanation',
};

const IDENTITY = {
  module: (row) => `${row.name}|${row.file}`,
  instance: (row) => `${row.parent}>${row.type}.${row.instance}|${row.file}`,
};

/**
 * Does this line sit inside a `for (genvar ...)` generate body?
 *
 * Heuristic on purpose: it walks upward from the instantiation looking for the
 * enclosing genvar loop, and stops at `endmodule`. It can be fooled by
 * pathological layout, which is why its verdict is reported as an explanation
 * and never used to drop a divergence.
 */
export function generateBlockReason(text, line1) {
  const lines = text.split('\n');
  const start = Math.min(line1, lines.length) - 1;
  const floor = Math.max(0, start - 160);
  for (let i = start; i >= floor; i--) {
    const raw = lines[i];
    if (/^\s*endmodule\b/.test(raw)) return null;
    if (/\bfor\s*\(\s*genvar\b/.test(raw) || /^\s*genvar\b/.test(raw)) {
      return { line1: i + 1 };
    }
  }
  return null;
}

/**
 * Does this line sit in an inactive `` `ifdef `` branch?
 *
 * Walks the file from the top maintaining the conditional stack, so `elsif` and
 * `else` are handled correctly. `defines` is a name->value map (presence is
 * what `` `ifdef `` tests, so only the keys matter).
 */
export function deadIfdefReason(text, line1, defines = {}) {
  const lines = text.split('\n');
  const isDefined = (macro) => Object.prototype.hasOwnProperty.call(defines, macro);
  const stack = [];
  const limit = Math.min(line1, lines.length);

  for (let i = 0; i < limit; i++) {
    const m = /^\s*`(ifdef|ifndef|elsif|else|endif)\b\s*([A-Za-z_]\w*)?/.exec(lines[i]);
    if (!m) continue;
    const directive = m[1];
    const macro = m[2] || null;
    if (directive === 'ifdef' || directive === 'ifndef') {
      const active = directive === 'ifdef' ? isDefined(macro) : !isDefined(macro);
      stack.push({ macro, active, anyTaken: active });
    } else if (directive === 'elsif') {
      const top = stack[stack.length - 1];
      if (top) {
        top.active = !top.anyTaken && isDefined(macro);
        top.anyTaken = top.anyTaken || top.active;
      }
    } else if (directive === 'else') {
      const top = stack[stack.length - 1];
      if (top) {
        top.active = !top.anyTaken;
        top.anyTaken = true;
      }
    } else if (directive === 'endif') {
      stack.pop();
    }
  }

  // The outermost inactive frame is what makes the line dead.
  for (const frame of stack) {
    if (!frame.active) return { macro: frame.macro };
  }
  return null;
}

/** Does the instantiation use an arrayed form the builtin scanner misses? */
export function arrayedFormReason(text, line1) {
  const lines = text.split('\n');
  const start = Math.max(0, Math.min(line1, lines.length) - 1);
  for (const raw of lines.slice(start, start + 6)) {
    if (/\)\s*[A-Za-z_]\w*\s*\[[^\]]+\]\s*\(/.test(raw)) return true;
    if (/[A-Za-z_]\w*\s*\[[^\]]+\]\s*\(\s*\./.test(raw)) return true;
  }
  return false;
}

/** Normalise a bundle into comparable rows. */
export function rowsFromBundle(bundle) {
  return {
    backend: bundle?.provenance?.backend ?? 'builtin',
    modules: (bundle?.modules ?? []).map((m) => ({ name: m.name, file: m.file, line1: m.line })),
    instances: (bundle?.instantiations ?? []).map((i) => ({
      parent: i.parent, type: i.type, instance: i.instance, file: i.file, line1: i.line,
    })),
  };
}

/** Normalise an `rtlens.evidence/1` document into comparable rows. */
export function rowsFromEvidence(evidence) {
  return {
    backend: 'rtlens',
    modules: (evidence?.modules ?? []).map((m) => ({ name: m.name, file: m.file, line1: m.line1 })),
    instances: (evidence?.instances ?? []).map((i) => ({
      parent: i.parent, type: i.type, instance: i.instance, file: i.file, line1: i.line1,
    })),
  };
}

/**
 * Diff two engines. Pure: source text comes through `readSource(file)`, which
 * may return null when a file cannot be read (the divergence is then reported
 * unclassified rather than dropped).
 *
 * @param {{primary: object, secondary: object, readSource?: (file: string) => string|null,
 *          defines?: object, policy?: 'warn'|'strict', maxDivergences?: number}} opts
 */
export function diffEngines(opts) {
  const {
    primary, secondary, readSource = () => null, defines = {}, policy = 'warn', maxDivergences = 200,
  } = opts;
  const sourceCache = new Map();
  const source = (file) => {
    if (!sourceCache.has(file)) {
      let text = null;
      try { text = readSource(file); } catch { text = null; }
      sourceCache.set(file, text);
    }
    return sourceCache.get(file);
  };

  const divergences = [];
  const counts = {
    coordinateMismatches: 0,
    coverageOnly: 0,
    byCategory: {},
    modules: { primary: primary.modules.length, secondary: secondary.modules.length, shared: 0 },
    instances: { primary: primary.instances.length, secondary: secondary.instances.length, shared: 0 },
  };
  let truncated = false;

  const classify = (kind, identity, extra) => {
    // Explanation lookup, in order of how much it tells a reviewer.
    const text = extra.file ? source(extra.file) : null;
    if (extra.reportedBy === 'secondary' || extra.reportedBy === 'primary') {
      const line = extra.reportedLine;
      if (text && line) {
        const dead = deadIfdefReason(text, line, defines);
        if (dead) return { category: CATEGORIES.deadIfdef, detail: `\`${dead.macro ?? '?'} is not defined` };
        const gen = generateBlockReason(text, line);
        if (gen) return { category: CATEGORIES.generateBlock, detail: `enclosing genvar loop at line ${gen.line1}` };
        if (kind === 'instance' && arrayedFormReason(text, line)) {
          return { category: CATEGORIES.arrayedForm, detail: 'arrayed instantiation form' };
        }
      }
    }
    return { category: CATEGORIES.coverageOnly, detail: null };
  };

  const push = (entry) => {
    if (divergences.length >= maxDivergences) { truncated = true; return; }
    counts.byCategory[entry.category] = (counts.byCategory[entry.category] ?? 0) + 1;
    if (entry.category === CATEGORIES.coordinateMismatch) counts.coordinateMismatches += 1;
    else counts.coverageOnly += 1;
    divergences.push({ ...entry, note: CATEGORY_NOTES[entry.category] });
  };

  for (const kind of ['module', 'instance']) {
    const key = kind === 'module' ? 'modules' : 'instances';
    const group = (rows) => {
      const map = new Map();
      for (const row of rows) {
        const id = IDENTITY[kind](row);
        if (!map.has(id)) map.set(id, { row, lines: new Set() });
        map.get(id).lines.add(row.line1);
      }
      return map;
    };
    const left = group(primary[key]);
    const right = group(secondary[key]);
    counts[key].shared = [...left.keys()].filter((id) => right.has(id)).length;

    for (const [id, a] of left) {
      const b = right.get(id);
      const aLines = [...a.lines].sort((x, y) => x - y);
      if (!b) {
        const verdict = classify(kind, id, { file: a.row.file, reportedBy: 'primary', reportedLine: aLines[0] });
        push({
          category: verdict.category, kind, identity: id, file: a.row.file,
          primaryLines: aLines, secondaryLines: [], reportedBy: 'primary', detail: verdict.detail,
        });
        continue;
      }
      const bLines = [...b.lines].sort((x, y) => x - y);
      const shared = aLines.filter((line) => bLines.includes(line));
      if (shared.length === 0) {
        push({
          category: CATEGORIES.coordinateMismatch, kind, identity: id, file: a.row.file,
          primaryLines: aLines, secondaryLines: bLines, reportedBy: 'both',
          detail: 'the two engines never point at the same line',
        });
      } else if (aLines.length !== bLines.length) {
        const verdict = classify(kind, id, { file: a.row.file, reportedBy: 'primary', reportedLine: aLines[0] });
        push({
          category: verdict.category, kind, identity: id, file: a.row.file,
          primaryLines: aLines, secondaryLines: bLines, reportedBy: 'both',
          detail: `same fact, different site count (${aLines.length} vs ${bLines.length})${verdict.detail ? `; ${verdict.detail}` : ''}`,
        });
      }
    }

    for (const [id, b] of right) {
      if (left.has(id)) continue;
      const bLines = [...b.lines].sort((x, y) => x - y);
      const verdict = classify(kind, id, { file: b.row.file, reportedBy: 'secondary', reportedLine: bLines[0] });
      push({
        category: verdict.category, kind, identity: id, file: b.row.file,
        primaryLines: [], secondaryLines: bLines, reportedBy: 'secondary', detail: verdict.detail,
      });
    }
  }

  divergences.sort((x, y) => (
    (x.category === CATEGORIES.coordinateMismatch ? -1 : 0) - (y.category === CATEGORIES.coordinateMismatch ? -1 : 0)
    || String(x.file).localeCompare(String(y.file))
    || x.identity.localeCompare(y.identity)
  ));

  return {
    schema: CROSS_CHECK_SCHEMA,
    policy,
    primary: primary.backend,
    secondary: secondary.backend,
    counts,
    divergences,
    truncated,
    verdict: counts.coordinateMismatches > 0 ? 'coordinate-mismatch' : (divergences.length > 0 ? 'coverage-differs' : 'agree'),
  };
}

/** Wrap a builtin bundle as a cross-check witness. */
export function witnessFromBuiltin(bundle) {
  return { backend: 'builtin', rows: rowsFromBundle(bundle) };
}

/** Wrap an `rtlens.evidence/1` document as a cross-check witness. */
export function witnessFromEvidence(evidence) {
  return { backend: 'rtlens', rows: rowsFromEvidence(evidence) };
}

/**
 * Run the cross-check for one root.
 *
 * The primary document is whatever produced the diagram; `secondary` is a
 * ready-made witness for the OTHER engine (or `{unavailable, reason}`). Running
 * the second engine is the caller's job, because that is where backend
 * resolution already lives. Never throws: an unavailable witness is disclosed
 * as `checked: false`, and the caller decides whether strict mode cares.
 *
 * @param {string} root
 * @param {{primaryBundle: object, primaryBackend: string, secondary: object,
 *          policy?: 'warn'|'strict', defines?: object,
 *          readFile?: (abs: string) => string, maxDivergences?: number}} opts
 */
export function runCrossCheck(root, opts) {
  const {
    primaryBundle, primaryBackend, secondary, policy = 'warn', defines = {}, readFile,
  } = opts;

  if (!secondary || secondary.unavailable) {
    return {
      schema: CROSS_CHECK_SCHEMA,
      policy,
      primary: primaryBackend,
      secondary: null,
      checked: false,
      secondaryUnavailable: secondary?.reason ?? 'secondary engine not available',
      counts: null,
      divergences: [],
      truncated: false,
      verdict: 'not-checked',
    };
  }

  const read = readFile ?? ((abs) => fs.readFileSync(abs, 'utf8'));
  const readSource = (file) => {
    try { return read(path.resolve(root, file)); } catch { return null; }
  };

  const diff = diffEngines({
    primary: rowsFromBundle(primaryBundle),
    secondary: secondary.rows,
    readSource,
    defines,
    policy,
    maxDivergences: opts.maxDivergences,
  });
  return { ...diff, checked: true };
}
