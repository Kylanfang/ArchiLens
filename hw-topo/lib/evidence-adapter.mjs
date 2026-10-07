// RTLens evidence -> hw-topo bundle adapter.
//
// This module is the ONE place where the two coordinate systems meet, and it
// is a pure transcription: it picks `line1`/`endLine1` verbatim, copies paths
// verbatim, and throws on anything it cannot copy exactly. It never re-scans
// the RTL, never normalises a name, and never guesses a missing field — see
// docs/EVIDENCE_CONTRACT.md §3 ("转录不完整就报错退出,而不是尽力而为").
//
// Why the strictness matters (§0 of the contract): RTLens reports 0-based
// lines and absolute Windows paths; hw-topo spec/verify speak 1-based lines
// and root-relative POSIX paths. Feeding one into the other without this
// adapter makes every element look stale, and hw-topo's verify gate then
// accuses a truthful index of hallucinating (exit 1).

import path from 'node:path';

/** Schema id this adapter accepts. Anything else is rejected (§5). */
export const EVIDENCE_SCHEMA = 'rtlens.evidence/1';

/** Bundle schema id written into every bundle this adapter produces. */
export const BUNDLE_SCHEMA_ID = 'hw-topo.bundle/1';

/**
 * True when `file` is a root-relative POSIX path (contract R2): no backslash,
 * no drive letter, no leading `/`, no `..` segment, no NUL. Identical rule to
 * `resolveInsideRoot` / `structuralDiagnostics` so a transcribed path can
 * never be rejected later by the reader or by the structural gate.
 */
function isRelativePosix(file) {
  return typeof file === 'string' && file.length > 0 &&
    !file.includes('\\') && !file.includes('\0') &&
    !file.startsWith('/') && !/^[A-Za-z]:/.test(file) &&
    !file.split('/').includes('..');
}

/** Throw unless `file` is a root-relative POSIX path. */
function assertRelativePosix(file, where) {
  if (!isRelativePosix(file)) {
    throw new Error(
      `evidenceToBundle: ${where} has file=${JSON.stringify(file)}, which is not a root-relative POSIX path ` +
      '(no backslash, no drive letter, no leading "/", no "..") — contract R2',
    );
  }
  return file;
}

/**
 * Throw unless `line1 === line0 + 1` for one coordinate pair. This is the
 * off-by-one tripwire (contract R1): it fires at the exact element that
 * violates the invariant instead of silently shifting a whole diagram by one.
 */
function assertLinePair(line0, line1, where) {
  if (!Number.isInteger(line0) || !Number.isInteger(line1)) {
    throw new Error(`evidenceToBundle: ${where} is missing integer line0/line1 (got ${JSON.stringify(line0)}/${JSON.stringify(line1)}) — contract R1/R4`);
  }
  if (line1 !== line0 + 1) {
    throw new Error(`evidenceToBundle: ${where} violates line1 === line0 + 1 (line0=${line0}, line1=${line1}) — off-by-one, contract R1`);
  }
  return line1;
}

/** Names from an upstream `ports`/`params`/`signals` array (objects or plain strings). */
function namesOf(list, where) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) {
    throw new Error(`evidenceToBundle: ${where} must be an array (got ${typeof list})`);
  }
  return list.map((entry, i) => {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (typeof name !== 'string' || !name) {
      throw new Error(`evidenceToBundle: ${where}[${i}] has no usable name (got ${JSON.stringify(entry)?.slice(0, 80)})`);
    }
    return name;
  });
}

/**
 * Top-level `instances[]` is the source of truth for the instantiation list:
 * it is the flattened superset of `modules[].instances[]`, carries `parent`
 * (which the module-nested form only implies), and is what contract §3 maps.
 * `modules[].instances[]` is used only when the top-level array is absent or
 * empty; the chosen source is recorded in `provenance.instantiationSource`.
 */
function collectInstantiations(evidence) {
  const topLevel = evidence.instances;
  if (Array.isArray(topLevel) && topLevel.length > 0) {
    const rows = topLevel.map((inst, i) => {
      const where = `instances[${i}] (${inst?.parent} -> ${inst?.type} ${inst?.instance})`;
      if (typeof inst?.parent !== 'string' || !inst.parent ||
          typeof inst?.type !== 'string' || !inst.type ||
          typeof inst?.instance !== 'string' || !inst.instance) {
        throw new Error(`evidenceToBundle: ${where} needs string parent/type/instance`);
      }
      return {
        parent: inst.parent,
        type: inst.type,
        instance: inst.instance,
        file: assertRelativePosix(inst.file, where),
        line: assertLinePair(inst.line0, inst.line1, where),
      };
    });
    return { rows, source: 'instances[]' };
  }

  // Fallback: flatten modules[].instances[]. `parent` is the declaring module.
  const rows = [];
  for (const mod of evidence.modules || []) {
    for (const inst of mod?.instances || []) {
      const where = `modules[${mod?.name}].instances[${inst?.name}]`;
      rows.push({
        parent: mod.name,
        type: inst.type,
        instance: inst.name,
        file: assertRelativePosix(inst.file ?? mod.file, where),
        line: assertLinePair(inst.line0, inst.line1, where),
      });
    }
  }
  return { rows, source: rows.length ? 'modules[].instances[]' : 'instances[]' };
}

/**
 * Transcribe one `rtlens.evidence/1` document into an hw-topo bundle.
 *
 * @param {object} evidence parsed `rtlens.evidence/1` JSON
 * @param {{root?: string, defines?: Record<string,string>, evidenceFile?: string}} [opts]
 *        `evidenceFile` is recorded verbatim in provenance so a spec derived
 *        from a saved document always names that document.
 * @returns {object} hw-topo evidence bundle (1-based lines, root-relative POSIX files)
 */
export function evidenceToBundle(evidence, opts = {}) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('evidenceToBundle: evidence must be a JSON object');
  }
  if (evidence.schema !== EVIDENCE_SCHEMA) {
    throw new Error(
      `evidenceToBundle: unsupported evidence schema ${JSON.stringify(evidence.schema)} — ` +
      `this consumer only accepts ${EVIDENCE_SCHEMA} (no compatibility parsing, contract §5)`,
    );
  }

  // ---- files ------------------------------------------------------------
  const files = (evidence.files || []).map((file, i) => {
    const where = `files[${i}]`;
    return {
      path: assertRelativePosix(file?.path, where),
      bytes: file?.bytes ?? null,
      lines: file?.lines ?? null,
      sha256: file?.sha256 ?? null,
    };
  });

  // ---- modules ----------------------------------------------------------
  const modules = (evidence.modules || []).map((mod, i) => {
    const where = `modules[${i}] (${mod?.name})`;
    if (typeof mod?.name !== 'string' || !mod.name) {
      throw new Error(`evidenceToBundle: ${where} has no name`);
    }
    const line = assertLinePair(mod.line0, mod.line1, where);
    const endLine = assertLinePair(mod.endLine0, mod.endLine1, `${where} endLine`);
    if (endLine < line) {
      throw new Error(`evidenceToBundle: ${where} endLine1=${endLine} precedes line1=${line}`);
    }
    const ports = namesOf(mod.ports, `${where}.ports`);
    const params = namesOf(mod.params, `${where}.params`);
    return {
      name: mod.name,
      kind: mod.kind ?? 'module',
      file: assertRelativePosix(mod.file, where),
      line,
      endLine,
      portCount: Number.isInteger(mod.portCount) ? mod.portCount : ports.length,
      ports,
      params,
      role: null, // resolved below
    };
  });

  // ---- instantiations ---------------------------------------------------
  const { rows: instantiations, source: instantiationSource } = collectInstantiations(evidence);

  // ---- unresolved -------------------------------------------------------
  const unresolved = (evidence.unresolved || []).map((un, i) => {
    const where = `unresolved[${i}] (${un?.type})`;
    if (typeof un?.type !== 'string' || !un.type) {
      throw new Error(`evidenceToBundle: ${where} has no type`);
    }
    if (un.classification !== 'vendor-primitive' && un.classification !== 'unknown') {
      throw new Error(
        `evidenceToBundle: ${where} has classification=${JSON.stringify(un.classification)} — ` +
        'hw-topo only buckets vendor-primitive | unknown; transcribe this faithfully upstream',
      );
    }
    return {
      type: un.type,
      classification: un.classification,
      file: assertRelativePosix(un.file, where),
      line: assertLinePair(un.line0, un.line1, where),
      count: Number.isInteger(un.count) ? un.count : 1,
      parents: Array.isArray(un.parents) ? un.parents.slice(0, 16) : [],
    };
  });

  // ---- role -------------------------------------------------------------
  // Upstream `role` is authoritative when present. When it is absent we fall
  // back to hw-topo's own rule ("instantiated by anyone -> leaf-or-mid, else
  // top"). This is the only place in this adapter that derives instead of
  // transcribes, and it only fires on a missing field; the fallback is
  // recorded in provenance.
  const instantiatedTypes = new Set(instantiations.map((i) => i.type));
  let roleFallbacks = 0;
  for (const [i, mod] of modules.entries()) {
    const upstreamRole = evidence.modules?.[i]?.role;
    if (typeof upstreamRole === 'string' && upstreamRole) {
      mod.role = upstreamRole;
    } else {
      mod.role = instantiatedTypes.has(mod.name) ? 'leaf-or-mid' : 'top';
      roleFallbacks++;
    }
  }

  // ---- stats ------------------------------------------------------------
  // Recounted from the transcribed rows so the numbers describe THIS bundle,
  // never the upstream document (contract §3 maps stats by counting).
  const unresolvedVendor = unresolved.filter((u) => u.classification === 'vendor-primitive').length;
  const stats = {
    files: files.length,
    modules: modules.length,
    instantiations: instantiations.length,
    unresolvedVendor,
    unresolvedUnknown: unresolved.length - unresolvedVendor,
  };

  const root = evidence.root?.abs ?? opts.root ?? null;

  return {
    tool: `rtlens-evidence-adapter (${evidence.tool?.name ?? 'rtlens'} ${evidence.tool?.version ?? 'unknown'})`,
    schema: 1, // numeric form kept for the existing scan/derive/verify consumers
    schemaId: BUNDLE_SCHEMA_ID,
    root,
    rootSeparator: evidence.root?.separator ?? (root ? path.sep : null),
    scannedAt: evidence.generatedAt ?? new Date().toISOString(),
    files,
    modules,
    instantiations,
    unresolved,
    stats,
    // The producer's own caveats must survive the seam instead of dying in the
    // adapter. `parseErrors > 0` means the coordinates are suspect, and an
    // outside-root count means the COVERAGE is incomplete (the contract says a
    // consumer "应据此提示用户"). Silently dropping them would let a clean
    // verdict overstate what was actually read. `signals`/`connections`
    // truncation counts ride along as data; they cannot change any bundle row
    // because this adapter does not transcribe signal or connection lists.
    ...(transcribeEvidenceDiagnostics(evidence.diagnostics) ?? {}),
    provenance: {
      backend: 'rtlens',
      degraded: false,
      reason: null,
      evidenceSchema: evidence.schema,
      tool: { name: evidence.tool?.name ?? 'rtlens', version: evidence.tool?.version ?? null },
      defines: evidence.defines ?? opts.defines ?? {},
      rootAbs: root,
      instantiationSource,
      roleFallbacks,
      ...(opts.evidenceFile ? { evidenceFile: opts.evidenceFile } : {}),
    },
  };
}

/**
 * Transcribe the producer's `diagnostics` block, field by field.
 * Whitelisted on purpose: this is a cross-tool contract, so unknown upstream
 * fields are dropped rather than forwarded into a shape nobody agreed on.
 *
 * @param {object|undefined} diag
 * @returns {{diagnostics: object}|undefined} `undefined` when there is nothing to say
 */
function transcribeEvidenceDiagnostics(diag) {
  if (!diag || typeof diag !== 'object' || Array.isArray(diag)) return undefined;
  const out = {};
  if (Number.isInteger(diag.parseErrors)) out.parseErrors = diag.parseErrors;
  if (diag.elaborated === false) out.elaborated = false;
  if (Number.isInteger(diag.signalsTruncatedModules)) out.signalsTruncatedModules = diag.signalsTruncatedModules;
  if (Number.isInteger(diag.connectionsTruncatedInstances)) out.connectionsTruncatedInstances = diag.connectionsTruncatedInstances;
  if (Array.isArray(diag.outsideRootFiles)) out.outsideRootFiles = diag.outsideRootFiles.slice(0, 64);
  if (Number.isInteger(diag.outsideRootCount)) out.outsideRootCount = diag.outsideRootCount;
  // The file-level cap: "not scanned" must never be read as "does not exist".
  if (diag.filesCapped === true) out.filesCapped = true;
  return Object.keys(out).length ? { diagnostics: out } : undefined;
}

/**
 * Lightweight self-check of a bundle's shape (doctor / tests).
 * Mirrors the invariants `evidenceToBundle` guarantees:
 * lines are 1-based integers inside a 1-based model, file paths stay inside
 * the root, and `stats` agrees with the arrays it summarises.
 *
 * @param {object} bundle
 * @returns {Array<{severity: 'error'|'warning', code: string, message: string}>}
 *          empty array == shape is valid
 */
export function validateBundleShape(bundle) {
  const findings = [];
  const err = (code, message) => findings.push({ severity: 'error', code, message });
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    err('bundle/not-object', 'bundle must be a JSON object');
    return findings;
  }
  for (const key of ['files', 'modules', 'instantiations', 'unresolved']) {
    if (!Array.isArray(bundle[key])) err(`bundle/${key}`, `bundle.${key} must be an array`);
  }
  if (!bundle.stats || typeof bundle.stats !== 'object') err('bundle/stats', 'bundle.stats must be an object');
  if (bundle.root !== null && bundle.root !== undefined && typeof bundle.root !== 'string') {
    err('bundle/root', 'bundle.root must be a string or null');
  }

  for (const [i, file] of (bundle.files || []).entries()) {
    if (!isRelativePosix(file?.path)) err('bundle/file-path', `files[${i}].path ${JSON.stringify(file?.path)} is not root-relative POSIX`);
  }
  for (const [i, mod] of (bundle.modules || []).entries()) {
    const at = `modules[${i}] (${mod?.name})`;
    if (typeof mod?.name !== 'string' || !mod.name) err('bundle/module-name', `${at} has no name`);
    if (!isRelativePosix(mod?.file)) err('bundle/file-path', `${at} file ${JSON.stringify(mod?.file)} is not root-relative POSIX`);
    if (!Number.isInteger(mod?.line) || mod.line < 1) err('bundle/line-basis', `${at} line ${JSON.stringify(mod?.line)} is not a 1-based line`);
    if (mod?.endLine !== undefined && (!Number.isInteger(mod.endLine) || mod.endLine < mod.line)) {
      err('bundle/line-basis', `${at} endLine ${JSON.stringify(mod.endLine)} is before line ${mod.line}`);
    }
    if (!Array.isArray(mod?.ports)) err('bundle/module-ports', `${at}.ports must be an array of names`);
    if (!Array.isArray(mod?.params)) err('bundle/module-params', `${at}.params must be an array of names`);
    if (mod?.role !== undefined && mod.role !== null && typeof mod.role !== 'string') err('bundle/module-role', `${at}.role must be a string`);
  }
  for (const [i, inst] of (bundle.instantiations || []).entries()) {
    const at = `instantiations[${i}] (${inst?.parent} -> ${inst?.type})`;
    if (!inst?.parent || !inst?.type || !inst?.instance) err('bundle/instantiation-shape', `${at} needs parent/type/instance`);
    if (!isRelativePosix(inst?.file)) err('bundle/file-path', `${at} file ${JSON.stringify(inst?.file)} is not root-relative POSIX`);
    if (!Number.isInteger(inst?.line) || inst.line < 1) err('bundle/line-basis', `${at} line ${JSON.stringify(inst?.line)} is not a 1-based line`);
  }
  for (const [i, un] of (bundle.unresolved || []).entries()) {
    const at = `unresolved[${i}] (${un?.type})`;
    if (!un?.type) err('bundle/unresolved-shape', `${at} needs a type`);
    if (un?.classification !== 'vendor-primitive' && un?.classification !== 'unknown') {
      err('bundle/unresolved-classification', `${at} classification must be vendor-primitive | unknown`);
    }
    if (!isRelativePosix(un?.file)) err('bundle/file-path', `${at} file ${JSON.stringify(un?.file)} is not root-relative POSIX`);
    if (!Number.isInteger(un?.line) || un.line < 1) err('bundle/line-basis', `${at} line ${JSON.stringify(un?.line)} is not a 1-based line`);
  }

  if (bundle.stats && Array.isArray(bundle.files) && Array.isArray(bundle.modules) &&
      Array.isArray(bundle.instantiations) && Array.isArray(bundle.unresolved)) {
    const expected = {
      files: bundle.files.length,
      modules: bundle.modules.length,
      instantiations: bundle.instantiations.length,
      unresolvedVendor: bundle.unresolved.filter((u) => u?.classification === 'vendor-primitive').length,
      unresolvedUnknown: bundle.unresolved.filter((u) => u?.classification === 'unknown').length,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (bundle.stats[key] !== value) {
        err('bundle/stats-mismatch', `stats.${key} is ${JSON.stringify(bundle.stats[key])} but the array holds ${value}`);
      }
    }
  }
  return findings;
}
