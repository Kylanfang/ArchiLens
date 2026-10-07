// Verification gate: re-scan the RTL root and check every spec element
// against fresh source truth. This is the self-check that keeps the
// hallucination rate near zero — nothing in the diagram is trusted until it
// resolves to a real file, a real line, and matching content.
//
// Verdict classes per element:
//   backed     — evidence resolves exactly (module/instance/line all match)
//   disclosed  — not source-backed, but explicitly listed in
//                meta.disclosed_unverified with a reason (rendered with a
//                warning style; excluded from the risk numerator)
//   unbacked   — no evidence resolves (counts as potential hallucination)
//   broken     — evidence points at a file/line that moved or content that
//                changed (stale claim; counts as potential hallucination)

import fs from 'node:fs';
import path from 'node:path';
import { scanRtl } from './scan-rtl.mjs';
import { sha256Hex, sourceLine, resolveInsideRoot } from './util.mjs';

function readLineAt(root, relFile, line) {
  // Containment first: spec-authored evidence may never read outside the
  // scanned root (no `..` escapes, absolute paths, or drive letters).
  const abs = resolveInsideRoot(root, relFile);
  if (!abs || !fs.existsSync(abs)) return { exists: false };
  const text = fs.readFileSync(abs, 'utf8');
  const lines = text.split('\n');
  if (line < 1 || line > lines.length) return { exists: true, line: null };
  return { exists: true, line: (lines[line - 1] || '').trim(), sha256: sha256Hex(text) };
}

function findingFor(list, code, subject, message, supportedFixes) {
  list.push({ severity: 'error', code, subject, message, supportedFixes });
}

/**
 * @param {object} spec topology spec
 * @param {{root?: string, bundle?: object, maxFiles?: number,
 *          defines?: Record<string,string>}} opts
 *        `defines` is carried into the receipt so a re-scan is reproducible
 *        with the same `ifdef inputs the original evidence used (R5).
 */
export function verifySpec(spec, opts = {}) {
  const root = opts.root ?? spec.meta?.project?.root;
  if (!root) {
    throw new Error('verify: no RTL root (pass --root or keep meta.project.root)');
  }
  const fresh = opts.bundle ?? scanRtl(root, { maxFiles: opts.maxFiles });

  const modulesByName = new Map();
  for (const mod of fresh.modules) {
    if (!modulesByName.has(mod.name)) modulesByName.set(mod.name, []);
    modulesByName.get(mod.name).push(mod);
  }
  const unresolvedByType = new Map(fresh.unresolved.map((u) => [u.type, u]));


  const disclosed = new Map((spec.meta?.disclosed_unverified || []).map((d) => [d.id, d.reason || '']));
  const findings = [];
  const rows = [];
  let backed = 0;
  let unbacked = 0;
  let broken = 0;
  let disclosedCount = 0;

  const record = (element, verdict, detail) => {
    rows.push({ element: element.id, kind: element.__kind, label: element.label ?? element.id, verdict, detail });
    if (verdict === 'backed') backed++;
    else if (verdict === 'disclosed') disclosedCount++;
    else if (verdict === 'broken') broken++;
    else unbacked++;
  };

  // ---- nodes ------------------------------------------------------------
  for (const node of spec.nodes || []) {
    node.__kind = 'node';
    const candidates = modulesByName.get(node.label) ?? [];
    const exact = candidates.find((m) => m.file === node.file && m.line === node.line);
    if (exact) {
      record(node, 'backed', `module ${node.label} at ${node.file}:${node.line}`);
      continue;
    }
    const primitiveSite = unresolvedByType.get(node.label);
    if (primitiveSite && (node.kind === 'primitive' || node.kind === 'unknown')) {
      const hit = readLineAt(root, node.file, node.line);
      if (!hit.exists) {
        if (disclosed.has(node.id)) { record(node, 'disclosed', disclosed.get(node.id)); continue; }
        findingFor(findings, 'node/file-missing', { id: node.id, file: node.file }, `node ${node.label}: evidence file ${node.file} does not exist under the root`, ['fix the path, or list the node in meta.disclosed_unverified with a reason']);
        record(node, 'broken', 'evidence file missing');
        continue;
      }
      if (hit.line && hit.line.includes(node.label)) {
        record(node, 'backed', `instantiation site of ${node.label} at ${node.file}:${node.line}`);
        continue;
      }
    }
    if (candidates.length > 0) {
      const alt = candidates[0];
      if (disclosed.has(node.id)) { record(node, 'disclosed', disclosed.get(node.id)); continue; }
      findingFor(findings, 'node/stale-pointer', { id: node.id, file: node.file, line: node.line }, `node ${node.label}: declared at ${alt.file}:${alt.line}, not ${node.file}:${node.line}`, [`update evidence to ${alt.file}:${alt.line}`, 'or rescan: node bin/hw-topo.mjs scan <root>']);
      record(node, 'broken', `stale: now at ${alt.file}:${alt.line}`);
      continue;
    }
    if (disclosed.has(node.id)) { record(node, 'disclosed', disclosed.get(node.id)); continue; }
    findingFor(findings, 'node/unresolved', { id: node.id, label: node.label }, `node ${node.label}: no such module in the scanned RTL tree`, ['delete the node', 'fix its name', 'or disclose it in meta.disclosed_unverified with a reason']);
    record(node, 'unbacked', 'module not found in scan');
  }

  // ---- instance edges -----------------------------------------------------
  const instIndex = new Map(); // `${parent}|${type}|${file}` -> [lines]
  for (const inst of fresh.instantiations) {
    const key = `${inst.parent}|${inst.type}|${inst.file}`;
    if (!instIndex.has(key)) instIndex.set(key, []);
    instIndex.get(key).push(inst.line);
  }
  const nodeIdToLabel = new Map((spec.nodes || []).map((n) => [n.id, n.label]));
  for (const edge of spec.instances || []) {
    edge.__kind = 'instance';
    const parentLabel = nodeIdToLabel.get(edge.parent) ?? edge.parent;
    const childLabel = nodeIdToLabel.get(edge.child) ?? edge.child;
    const key = `${parentLabel}|${childLabel}|${edge.file}`;
    const lines = instIndex.get(key);
    if (lines && lines.includes(edge.line)) {
      record(edge, 'backed', `${parentLabel} instantiates ${childLabel} at ${edge.file}:${edge.line}`);
      continue;
    }
    if (lines && lines.length) {
      if (disclosed.has(edge.id)) { record(edge, 'disclosed', disclosed.get(edge.id)); continue; }
      findingFor(findings, 'instance/stale-pointer', { id: edge.id, file: edge.file, line: edge.line }, `instance ${parentLabel}→${childLabel}: found at ${edge.file}:${lines[0]}, not line ${edge.line}`, [`update line to ${lines[0]}`]);
      record(edge, 'broken', `stale: now line ${lines[0]}`);
      continue;
    }
    // Looser match anywhere in the tree.
    const anyRel = fresh.instantiations.find((i) => i.parent === parentLabel && i.type === childLabel);
    if (anyRel) {
      if (disclosed.has(edge.id)) { record(edge, 'disclosed', disclosed.get(edge.id)); continue; }
      findingFor(findings, 'instance/stale-pointer', { id: edge.id, file: edge.file }, `instance ${parentLabel}→${childLabel}: found at ${anyRel.file}:${anyRel.line}, not ${edge.file}:${edge.line}`, [`update evidence to ${anyRel.file}:${anyRel.line}`]);
      record(edge, 'broken', `stale: now ${anyRel.file}:${anyRel.line}`);
      continue;
    }
    if (disclosed.has(edge.id)) { record(edge, 'disclosed', disclosed.get(edge.id)); continue; }
    findingFor(findings, 'instance/unresolved', { id: edge.id, parent: parentLabel, child: childLabel }, `instance ${parentLabel}→${childLabel}: no such instantiation in the scanned tree`, ['delete the edge', 'fix names', 'or disclose it with a reason']);
    record(edge, 'unbacked', 'instantiation not found in scan');
  }

  // ---- connections ----------------------------------------------------
  for (const conn of spec.connections || []) {
    conn.__kind = 'connection';
    const fromLabel = nodeIdToLabel.get(conn.from) ?? conn.from;
    const toLabel = nodeIdToLabel.get(conn.to) ?? conn.to;
    const hit = readLineAt(root, conn.file, conn.line);
    if (!hit.exists) {
      if (disclosed.has(conn.id)) { record(conn, 'disclosed', disclosed.get(conn.id)); continue; }
      findingFor(findings, 'connection/file-missing', { id: conn.id, file: conn.file }, `connection ${conn.signal}: evidence file ${conn.file} does not exist`, ['fix the path or disclose']);
      record(conn, 'broken', 'evidence file missing');
      continue;
    }
    if (hit.line === null) {
      if (disclosed.has(conn.id)) { record(conn, 'disclosed', disclosed.get(conn.id)); continue; }
      findingFor(findings, 'connection/line-out-of-range', { id: conn.id, file: conn.file, line: conn.line }, `connection ${conn.signal}: line ${conn.line} is out of range in ${conn.file}`, ['point at a line that contains the signal']);
      record(conn, 'broken', 'line out of range');
      continue;
    }
    const connAbs = resolveInsideRoot(root, conn.file);
    const connText = connAbs ? fs.readFileSync(connAbs, 'utf8') : '';
    const window = [];
    for (let d = -1; d <= 1; d++) {
      const text = sourceLine(connText, conn.line + d);
      if (text !== null) window.push(text);
    }
    if (window.some((t) => t.includes(conn.signal))) {
      record(conn, 'backed', `${conn.signal} at ${conn.file}:${conn.line} (${fromLabel}→${toLabel})`);
    } else if (disclosed.has(conn.id)) {
      record(conn, 'disclosed', disclosed.get(conn.id));
    } else {
      findingFor(findings, 'connection/signal-not-on-line', { id: conn.id, file: conn.file, line: conn.line, signal: conn.signal }, `connection ${conn.signal}: signal name does not appear on/around ${conn.file}:${conn.line}`, ['move evidence to a line that contains the signal', 'or disclose']);
      record(conn, 'unbacked', 'signal not found at evidence line');
    }
  }

  // ---- groups -----------------------------------------------------------
  const nodeIds = new Set((spec.nodes || []).map((n) => n.id));
  for (const group of spec.groups || []) {
    group.__kind = 'group';
    const missing = (group.members || []).filter((m) => !nodeIds.has(m));
    if (missing.length === 0) {
      record(group, 'backed', `group of ${group.members.length} members`);
    } else {
      findingFor(findings, 'group/member-unknown', { id: group.id, missing }, `group ${group.label}: unknown members ${missing.join(', ')}`, ['fix member ids']);
      record(group, 'broken', `unknown members: ${missing.join(', ')}`);
    }
  }

  const total = rows.length || 1;
  // Disclosed elements pass the gate by design, but the receipt must say so
  // loudly — an all-disclosed spec is a claim set, not a verified map.
  if (disclosedCount > 0) {
    findings.push({
      severity: 'warning',
      code: 'disclosure/used',
      subject: { count: disclosedCount },
      message: `${disclosedCount} 个元素无源码证据,仅以显式披露保留(图中 ⚠ 虚线)。这不是已验证内容。`,
      supportedFixes: ['为这些元素补充源码或删除'],
    });
  }

  // The producer's caveats (rtlens `diagnostics`, transcribed by the adapter)
  // are surfaced next to the verdict. Warnings, not errors: an incomplete read
  // is not a false claim — but it must never be invisible either.
  const diag = opts.bundle?.diagnostics ?? null;
  if (Number.isInteger(diag?.parseErrors) && diag.parseErrors > 0) {
    findings.push({
      severity: 'warning',
      code: 'evidence/parse-errors',
      subject: { parseErrors: diag.parseErrors },
      message: `证据引擎报告 ${diag.parseErrors} 个解析错误:这些文件的坐标可能不可靠(已逐行比对通过的元素不受影响)。`,
      supportedFixes: ['先修复这些文件的语法', '或用 --backend builtin 交叉确认'],
    });
  }
  if (Number.isInteger(diag?.outsideRootCount) && diag.outsideRootCount > 0) {
    findings.push({
      severity: 'warning',
      code: 'evidence/incomplete-coverage',
      subject: { outsideRootCount: diag.outsideRootCount, outsideRootFiles: diag.outsideRootFiles ?? [] },
      message: `证据覆盖不完整:${diag.outsideRootCount} 个 root 之外的文件被索引后整体排除,图可能少于源码实际拥有的元素。`,
      supportedFixes: ['把这些文件移入 root', '或把 root 提到它们的共同上级后重扫'],
    });
  }
  if (diag?.filesCapped === true) {
    findings.push({
      severity: 'warning',
      code: 'evidence/files-capped',
      subject: { stats: opts.bundle?.stats ?? null },
      message: '证据覆盖不完整:索引在 --max-files 上限处提前停止,还有文件没被读到("没扫到"不等于"不存在")。',
      supportedFixes: ['提高 --max-files 后重扫', '或缩小 root 到真正关心的子树'],
    });
  }

  const metrics = {
    elements: rows.length,
    backed,
    disclosed: disclosedCount,
    unbacked,
    broken,
    hallucinationRisk: Number(((unbacked + broken) / total).toFixed(4)),
  };
  return {
    ok: unbacked === 0 && broken === 0,
    root,
    scannedAt: fresh.scannedAt,
    stats: fresh.stats,
    // Evidence grade of the bundle actually used (contract §4 / R6). The
    // grading logic above is deliberately untouched: it is the correct
    // 1-based reference implementation.
    provenance: opts.bundle?.provenance ?? null,
    defines: opts.defines ?? opts.bundle?.provenance?.defines ?? {},
    metrics,
    rows,
    findings,
  };
}

/** Strip the internal __kind markers verify adds. */
export function cleanReceipt(receipt) {
  return JSON.parse(JSON.stringify(receipt, (k, v) => (k === '__kind' ? undefined : v)));
}
