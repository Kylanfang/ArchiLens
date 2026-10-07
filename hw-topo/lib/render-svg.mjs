// Pure-SVG builder for the topology diagram. Produces a standalone <svg>
// string used both by the interactive HTML viewer and the .svg export.
//
// Semantic classes (not inline colors) drive theming: the viewer injects CSS
// variables; the .svg export resolves them for the light theme.

import { escapeXml } from './util.mjs';
import { layoutTopology, NODE_W, NODE_H } from './layout.mjs';

const KIND_STEM = {
  module: 'mod',
  interface: 'ifc',
  primitive: 'prim',
  top: 'top',
  unknown: 'unk',
};

function truncate(text, max) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function nodeSvg(node, disclosedIds, links) {
  const disclosed = disclosedIds.has(node.id);
  const stem = KIND_STEM[node.kind] || 'mod';
  const url = links?.get(node.id);
  const body = `
  <g class="node kind-${stem}${disclosed ? ' disclosed' : ''}" data-id="${escapeXml(node.id)}" tabindex="0"
     transform="translate(${node.x},${node.y})" role="button" aria-label="${escapeXml(node.label)}">
    <rect class="node-box" width="${NODE_W}" height="${NODE_H}" rx="10"/>
    <rect class="node-stripe" width="6" height="${NODE_H - 12}" x="6" y="6" rx="3"/>
    <text class="node-label" x="20" y="26">${escapeXml(truncate(node.label, 24))}</text>
    <text class="node-sub" x="20" y="46">${escapeXml(truncate(`${node.file}:${node.line}`, 30))}</text>
    ${node.portCount != null ? `<text class="node-chip" x="${NODE_W - 12}" y="26" text-anchor="end">${escapeXml(String(node.portCount))}p</text>` : ''}
    ${disclosed ? `<text class="node-warn" x="${NODE_W - 12}" y="46" text-anchor="end">⚠</text>` : ''}
  </g>`;
  // Standalone SVG export: wrap the box in a permalink to the exact source
  // line when GitHub provenance is present.
  if (url) {
    return `
  <a class="node-link" href="${escapeXml(url)}" target="_blank" rel="noopener">${body}
  </a>`;
  }
  return body;
}

function edgePath(edge, from, to) {
  // Orthogonal elbow from parent bottom to child top.
  const x1 = from.x + NODE_W / 2;
  const y1 = from.y + NODE_H;
  const x2 = to.x + NODE_W / 2;
  const y2 = to.y;
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}

function crossPath(from, to) {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const dx = Math.max(60, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function connectionPath(from, to) {
  const x1 = from.x + NODE_W / 2;
  const y1 = from.y + 3;
  const x2 = to.x + NODE_W / 2;
  const y2 = to.y + 3;
  const dy = Math.max(50, Math.abs(y2 - y1) / 2);
  return `M ${x1} ${y1} C ${x1} ${y1 - dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
}

/**
 * Build the topology SVG markup.
 * @param {object} spec verified topology spec
 * @param {{receipt?: object, links?: Map}} opts receipt drives disclosed
 *   styling; `links` (nodeId -> permalink) wraps exported nodes in <a> —
 *   pass it only for the standalone .svg export, never the interactive
 *   viewer (it would hijack evidence-panel clicks).
 */
export function renderTopologySvg(spec, opts = {}) {
  const layout = layoutTopology(spec);
  const pos = new Map(layout.nodes.map((n) => [n.id, n]));
  const disclosedIds = new Set((spec.meta?.disclosed_unverified || []).map((d) => d.id));

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}"
  width="${layout.width}" height="${layout.height}" class="topo-svg" role="img"
  aria-label="${escapeXml(spec.meta?.title || 'RTL topology')}">`);
  parts.push(svgDefs());

  // Diagram title inside the SVG (survives .svg export).
  parts.push(`
  <text class="diagram-title" x="48" y="44">${escapeXml(spec.meta?.title || '')}</text>
  <text class="diagram-sub" x="48" y="66">${escapeXml(`${spec.nodes.length} 模块 · ${layout.primaryEdges.length + layout.crossEdges.length} 例化关系 · 有图有真相`)}</text>
  <text class="diagram-legend" x="48" y="${layout.height - 18}">—— 例化(主)   ⋯ 紫:交叉/共享例化   虚线框:原语·外部依赖   ⚠:已披露未验证</text>`);

  // Groups behind everything else.
  for (const group of layout.groups) {
    parts.push(`
  <g class="group" data-id="${escapeXml(group.id)}">
    <rect class="group-box" x="${group.x}" y="${group.y}" width="${group.w}" height="${group.h}" rx="14"/>
    <text class="group-label" x="${group.x + 12}" y="${group.y + 20}">${escapeXml(truncate(group.label, 28))}</text>
  </g>`);
  }

  // Edges first (under nodes).
  for (const edge of layout.primaryEdges) {
    const from = pos.get(edge.parent);
    const to = pos.get(edge.child);
    if (!from || !to) continue;
    parts.push(`
  <g class="edge" data-id="${escapeXml(edge.id)}" data-from="${escapeXml(edge.parent)}" data-to="${escapeXml(edge.child)}">
    <path class="edge-line" d="${edgePath(edge, from, to)}"/>
    <text class="edge-label" x="${(from.x + to.x) / 2 + NODE_W / 2}" y="${(from.y + NODE_H + to.y) / 2 - 6}" text-anchor="middle">${escapeXml(truncate(edge.label, 18))}</text>
  </g>`);
  }
  for (const edge of layout.crossEdges) {
    const from = pos.get(edge.parent);
    const to = pos.get(edge.child);
    if (!from || !to) continue;
    // Cross edges stay visually secondary: no always-on label (tooltip only)
    // so shared-module wiring cannot bury the primary tree.
    parts.push(`
  <g class="edge cross" data-id="${escapeXml(edge.id)}">
    <title>${escapeXml(`${edge.label} · ${edge.file}:${edge.line}`)}</title>
    <path class="edge-line" d="${crossPath(from, to)}"/>
  </g>`);
  }
  for (const conn of layout.connections) {
    const from = pos.get(conn.from);
    const to = pos.get(conn.to);
    if (!from || !to) continue;
    parts.push(`
  <g class="conn kind-${escapeXml(conn.kind)}" data-id="${escapeXml(conn.id)}">
    <path class="conn-line" d="${connectionPath(from, to)}"/>
    <text class="conn-label" x="${(from.x + to.x) / 2 + NODE_W / 2 + 10}" y="${Math.min(from.y, to.y) - 8}" text-anchor="middle">${escapeXml(truncate(conn.signal, 20))}</text>
  </g>`);
  }

  for (const node of layout.nodes) parts.push(nodeSvg(node, disclosedIds, opts.links));

  parts.push(`\n</svg>`);
  return { svg: parts.join('\n'), layout };
}

/** Static CSS with resolved light-theme colors, for the .svg export. */
export function svgExportStyle() {
  return `
.topo-svg { font-family: ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; background: #f7f8fa; }
.diagram-title { font-size: 22px; font-weight: 700; fill: #1a2233; }
.diagram-sub { font-size: 12px; fill: #6b7385; }
.group-box { fill: rgba(59, 130, 246, 0.05); stroke: rgba(59, 130, 246, 0.35); stroke-dasharray: 6 4; }
.group-label { font-size: 11px; fill: #4b5566; font-weight: 600; }
.node-box { fill: #ffffff; stroke: #c3cad8; stroke-width: 1.4; }
.node:hover .node-box, .node:focus .node-box { stroke: #2563eb; }
.node-stripe { fill: #64748b; }
.kind-top .node-stripe { fill: #059669; }
.kind-ifc .node-stripe { fill: #0891b2; }
.kind-prim .node-stripe { fill: #7c3aed; }
.kind-prim .node-box, .kind-unk .node-box { stroke-dasharray: 5 3; }
.kind-unk .node-stripe { fill: #9aa2b1; }
.node.disclosed .node-box { stroke-dasharray: 5 3; stroke: #d97706; }
.node-label { font-size: 14px; font-weight: 600; fill: #1a2233; }
.node-sub { font-size: 10.5px; fill: #6b7385; font-family: ui-monospace, Consolas, monospace; }
.node-chip { font-size: 10px; fill: #8a93a6; }
.node-warn { font-size: 12px; fill: #d97706; }
.edge-line { fill: none; stroke: #8a93a6; stroke-width: 1.6; marker-end: url(#topo-arrow); }
.edge.cross .edge-line { stroke-dasharray: 7 5; stroke: #a78bfa; stroke-width: 1.2; opacity: .75; }
.diagram-legend { font-size: 11px; fill: #8a93a6; }
.edge-label { font-size: 10px; fill: #5b6474; font-family: ui-monospace, Consolas, monospace; }
.conn-line { fill: none; stroke-width: 1.4; stroke-dasharray: 3 3; }
.conn.kind-data .conn-line { stroke: #2563eb; }
.conn.kind-clock .conn-line { stroke: #d97706; }
.conn.kind-reset .conn-line { stroke: #dc2626; }
.conn.kind-handshake .conn-line { stroke: #059669; }
.conn.kind-other .conn-line { stroke: #6b7385; }
.conn-label { font-size: 9.5px; fill: #5b6474; font-family: ui-monospace, Consolas, monospace; }
.arrow { fill: #8a93a6; }
`;
}

/** SVG defs (arrowhead marker) shared by viewer and export. */
export function svgDefs() {
  return `
  <defs>
    <marker id="topo-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 1 L 9 5 L 0 9 z" class="arrow"/>
    </marker>
  </defs>`;
}
