// Topology spec model: structural validation and mechanical derivation
// from an evidence bundle.
//
// The spec is the authored artifact. Structural validation here checks shape
// and referential integrity only — source truth is checked by verify.mjs
// against the real RTL tree.

import { shortId } from './util.mjs';

export const NODE_KINDS = ['module', 'interface', 'primitive', 'top', 'unknown'];
export const CONNECTION_KINDS = ['data', 'clock', 'reset', 'handshake', 'other'];

/** Evidence paths must be root-relative POSIX that stay inside the root. */
function fileDiagnostics(push, surface, file, where) {
  if (!file || typeof file !== 'string') {
    push('error', `${surface}/file-invalid`, { surface }, `${where}: file must be a root-relative string`, ['copy file from the bundle; never invent']);
    return;
  }
  if (file.includes('\\') || file.includes('\0') || /^[A-Za-z]:/.test(file) || file.startsWith('/') ||
      file.split('/').includes('..')) {
    push('error', `${surface}/file-outside-root`, { surface, file }, `${where}: evidence path escapes the RTL root`, ['use a root-relative POSIX path without ..']);
  }
}

export function structuralDiagnostics(spec) {
  const findings = [];
  const push = (severity, code, subject, message, supportedFixes = []) =>
    findings.push({ severity, code, subject, message, supportedFixes });

  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return [{ severity: 'error', code: 'spec/not-object', subject: {}, message: 'spec must be a JSON object', supportedFixes: ['start from `hw-topo derive` output'] }];
  }
  if (!spec.meta || typeof spec.meta !== 'object') push('error', 'meta/missing', { surface: 'meta' }, 'meta object is required', ['keep the meta block from `derive`']);
  if (!spec.meta?.title) push('error', 'meta/title-missing', { surface: 'meta' }, 'meta.title is required', ['set a short diagram title']);
  if (!spec.meta?.project?.root) push('error', 'meta/root-missing', { surface: 'meta' }, 'meta.project.root (RTL root used by scan) is required', ['copy the root from the scan receipt']);
  if (!Array.isArray(spec.nodes) || spec.nodes.length === 0) push('error', 'nodes/empty', { surface: 'nodes' }, 'at least one node is required', ['run `derive` to build nodes from the bundle']);

  const nodeIds = new Set();
  (spec.nodes || []).forEach((node, i) => {
    const subject = { surface: 'nodes', index: i, id: node?.id };
    if (!node.id) push('error', 'node/id-missing', subject, `node[${i}].id is required`);
    else if (nodeIds.has(node.id)) push('error', 'node/id-duplicate', subject, `duplicate node id ${node.id}`);
    else nodeIds.add(node.id);
    if (!node.label) push('error', 'node/label-missing', subject, `node ${node.id}: label is required`);
    if (!NODE_KINDS.includes(node.kind)) push('error', 'node/kind-invalid', subject, `node ${node.id}: kind must be one of ${NODE_KINDS.join('|')}`, [`use a kind produced by derive`]);
    if (!node.file) push('error', 'node/file-missing', subject, `node ${node.id}: evidence file is required`, ['copy file from the bundle; never invent']);
    else fileDiagnostics(push, 'node', node.file, `node ${node.id}`);
    if (!Number.isInteger(node.line) || node.line < 1) push('error', 'node/line-invalid', subject, `node ${node.id}: evidence line must be a positive integer`);
  });

  (spec.instances || []).forEach((edge, i) => {
    const subject = { surface: 'instances', index: i, id: edge?.id };
    if (!edge.id) push('error', 'instance/id-missing', subject, `instance[${i}].id is required`);
    if (!nodeIds.has(edge.parent)) push('error', 'instance/parent-unknown', subject, `instance ${edge.id}: parent ${edge.parent} is not a node`, ['add the parent node or fix the id']);
    if (!nodeIds.has(edge.child)) push('error', 'instance/child-unknown', subject, `instance ${edge.id}: child ${edge.child} is not a node`, ['add the child node or fix the id']);
    if (!edge.file) push('error', 'instance/file-missing', subject, `instance ${edge.id}: evidence file is required`);
    else fileDiagnostics(push, 'instance', edge.file, `instance ${edge.id}`);
    if (!Number.isInteger(edge.line) || edge.line < 1) push('error', 'instance/line-invalid', subject, `instance ${edge.id}: evidence line must be a positive integer`);
  });

  (spec.connections || []).forEach((conn, i) => {
    const subject = { surface: 'connections', index: i, id: conn?.id };
    if (!conn.id) push('error', 'connection/id-missing', subject, `connection[${i}].id is required`);
    if (!nodeIds.has(conn.from)) push('error', 'connection/from-unknown', subject, `connection ${conn.id}: from ${conn.from} is not a node`);
    if (!nodeIds.has(conn.to)) push('error', 'connection/to-unknown', subject, `connection ${conn.id}: to ${conn.to} is not a node`);
    if (!conn.signal) push('error', 'connection/signal-missing', subject, `connection ${conn.id}: signal name is required`, ['a connection without a signal cannot be verified']);
    if (!CONNECTION_KINDS.includes(conn.kind)) push('error', 'connection/kind-invalid', subject, `connection ${conn.id}: kind must be one of ${CONNECTION_KINDS.join('|')}`);
    if (!conn.file) push('error', 'connection/file-missing', subject, `connection ${conn.id}: evidence file is required`);
    else fileDiagnostics(push, 'connection', conn.file, `connection ${conn.id}`);
    if (!Number.isInteger(conn.line) || conn.line < 1) push('error', 'connection/line-invalid', subject, `connection ${conn.id}: evidence line must be a positive integer`);
  });

  (spec.groups || []).forEach((group, i) => {
    const subject = { surface: 'groups', index: i, id: group?.id };
    if (!group.id) push('error', 'group/id-missing', subject, `group[${i}].id is required`);
    if (!group.label) push('error', 'group/label-missing', subject, `group ${group.id}: label is required`);
    for (const member of group.members || []) {
      if (!nodeIds.has(member)) push('error', 'group/member-unknown', subject, `group ${group.id}: member ${member} is not a node`);
    }
  });

  for (const d of spec.meta?.disclosed_unverified || []) {
    if (!d.id || !d.reason) push('error', 'disclosed/shape', { surface: 'meta' }, 'disclosed_unverified entries need id and reason');
  }

  return findings;
}

/**
 * Mechanically derive a full topology spec from an evidence bundle.
 * Every element carries its file:line evidence by construction — this is the
 * lowest-hallucination authoring path: the machine transcribes, the agent
 * only curates afterwards (delete, group, retitle; never add unverifiable
 * content).
 */
export function deriveSpec(bundle, opts = {}) {
  const focus = opts.focus ?? null;
  const groupByDir = opts.groupByDir !== false;

  const instantiatedTypes = new Set(bundle.instantiations.map((i) => i.type));
  const parentsOf = new Map(); // child type -> [{parent, instance, file, line}]
  for (const inst of bundle.instantiations) {
    if (!parentsOf.has(inst.type)) parentsOf.set(inst.type, []);
    parentsOf.get(inst.type).push(inst);
  }

  // Focus mode: keep the subtree rooted at `focus` (module name or `*`).
  let keepTypes = null;
  if (focus && focus !== '*') {
    const childrenOf = new Map();
    for (const inst of bundle.instantiations) {
      if (!childrenOf.has(inst.parent)) childrenOf.set(inst.parent, []);
      childrenOf.get(inst.parent).push(inst.type);
    }
    keepTypes = new Set([focus]);
    const queue = [focus];
    while (queue.length) {
      const cur = queue.shift();
      for (const child of childrenOf.get(cur) || []) {
        if (!keepTypes.has(child)) { keepTypes.add(child); queue.push(child); }
      }
    }
  }

  const nodes = [];
  const nodeTypeToId = new Map();
  for (const mod of bundle.modules) {
    if (keepTypes && !keepTypes.has(mod.name)) continue;
    if (nodeTypeToId.has(mod.name)) continue; // duplicate declaration: first wins, verify still checks
    const id = shortId('n', `${mod.file}:${mod.name}`);
    nodeTypeToId.set(mod.name, id);
    nodes.push({
      id,
      label: mod.name,
      kind: mod.kind === 'interface' ? 'interface'
        : instantiatedTypes.has(mod.name) ? 'module' : 'top',
      file: mod.file,
      line: mod.line,
      endLine: mod.endLine,
      portCount: mod.portCount,
      params: mod.params,
      evidence: [{ file: mod.file, line: mod.line, role: 'declaration' }],
    });
  }
  for (const un of bundle.unresolved) {
    if (keepTypes && !keepTypes.has(un.type)) continue;
    if (nodeTypeToId.has(un.type)) continue;
    const id = shortId('n', `${un.file}:${un.type}`);
    nodeTypeToId.set(un.type, id);
    nodes.push({
      id,
      label: un.type,
      kind: un.classification === 'vendor-primitive' ? 'primitive' : 'unknown',
      file: un.file,
      line: un.line,
      evidence: [{ file: un.file, line: un.line, role: 'instantiation-site' }],
    });
  }

  // Instance edges, aggregated per (parent, type).
  const edgeAgg = new Map();
  for (const inst of bundle.instantiations) {
    if (keepTypes && (!keepTypes.has(inst.parent) || !keepTypes.has(inst.type))) continue;
    const key = `${inst.parent}->${inst.type}`;
    if (!edgeAgg.has(key)) edgeAgg.set(key, { parent: inst.parent, type: inst.type, insts: [] });
    edgeAgg.get(key).insts.push(inst);
  }
  const instances = [];
  for (const [key, agg] of edgeAgg) {
    const parentId = nodeTypeToId.get(agg.parent);
    const childId = nodeTypeToId.get(agg.type);
    if (!parentId || !childId) continue; // parent not in focus set
    instances.push({
      id: shortId('i', key),
      parent: parentId,
      child: childId,
      label: agg.insts.length === 1 ? agg.insts[0].instance : `${agg.insts[0].instance} ×${agg.insts.length}`,
      count: agg.insts.length,
      file: agg.insts[0].file,
      line: agg.insts[0].line,
      evidence: agg.insts.slice(0, 8).map((i) => ({ file: i.file, line: i.line, role: 'instantiation' })),
    });
  }

  // Groups by top-level source directory (configurable).
  const groups = [];
  if (groupByDir) {
    const byDir = new Map();
    for (const node of nodes) {
      const dir = node.file.includes('/') ? node.file.split('/')[0] : '.';
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(node.id);
    }
    for (const [dir, members] of byDir) {
      if (dir === '.' || members.length < 2) continue; // don't box the root dir
      groups.push({
        id: shortId('g', dir),
        label: `${dir}/`,
        members,
        evidence: [{ file: `${dir}/`, line: 0, role: 'directory' }],
      });
    }
  }

  return {
    meta: {
      title: opts.title ?? `${focus && focus !== '*' ? focus : 'RTL'} 拓扑`,
      project: {
        name: opts.projectName ?? null,
        root: bundle.root,
      },
      language: opts.language ?? 'zh-CN',
      derivedFrom: {
        tool: bundle.tool,
        scannedAt: bundle.scannedAt,
        stats: bundle.stats,
        // Contract R5/R6: which evidence backend produced this spec, and
        // whether it was a degraded fallback. `verify`/`deliver` read this to
        // default to the SAME backend (a cross-backend verify would flood the
        // receipt with false `broken` findings).
        provenance: bundle.provenance ?? null,
      },
      disclosed_unverified: [],
    },
    nodes,
    instances,
    connections: [],
    groups,
  };
}
