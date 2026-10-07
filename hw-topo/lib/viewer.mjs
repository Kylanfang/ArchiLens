// Standalone interactive HTML viewer for a delivered topology.
//
// Self-contained: inline SVG + inline CSS + inline JSON (element index with
// evidence snippets captured at delivery time). No network, no JS deps.
// Click a node or edge to open its evidence in the side panel; search dims
// non-matching nodes; the footer table is the full codebase index.

import { escapeHtml } from './util.mjs';
import { githubBlobUrl } from './github.mjs';

export function buildViewerHtml({ spec, svg, snippets, receipt }) {
  const title = spec.meta?.title || 'RTL 拓扑';
  const index = buildElementIndex(spec, snippets, receipt);
  const indexJson = JSON.stringify(index).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="${escapeHtml(spec.meta?.language || 'zh-CN')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root {
  --bg: #f6f7f9; --panel: #ffffff; --ink: #1a2233; --muted: #6b7385;
  --line: #d9dee8; --accent: #2563eb; --warn: #d97706; --ok: #059669;
  --node-fill: #ffffff; --node-stroke: #c3cad8; --edge: #8a93a6;
  --code-bg: #eef1f6; --chip: #e7ebf2;
}
html.dark {
  --bg: #0f1420; --panel: #171e2e; --ink: #e6eaf2; --muted: #93a0b4;
  --line: #2a3347; --accent: #60a5fa; --warn: #fbbf24; --ok: #34d399;
  --node-fill: #1c2436; --node-stroke: #3b465e; --edge: #5b6779;
  --code-bg: #101827; --chip: #232d42;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font-family: ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
header { display: flex; align-items: center; gap: 16px; padding: 14px 22px;
  border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 5; }
header h1 { font-size: 17px; margin: 0; }
header .spacer { flex: 1; }
.badge { font-size: 11.5px; padding: 3px 10px; border-radius: 999px; background: var(--chip); color: var(--muted); }
.badge.ok { color: var(--ok); }
.badge.warn { color: var(--warn); }
button, input { font: inherit; color: inherit; }
button { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 6px 12px; cursor: pointer; }
button:hover { border-color: var(--accent); }
#search { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
  padding: 6px 12px; width: 220px; }
main { display: flex; min-height: calc(100vh - 61px); }
#stage { flex: 1; overflow: auto; padding: 18px; }
#stage svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
#panel { width: 400px; flex-shrink: 0; border-left: 1px solid var(--line);
  background: var(--panel); padding: 18px; overflow-y: auto; max-height: calc(100vh - 61px); }
#panel h2 { font-size: 14px; margin: 0 0 4px; font-family: ui-monospace, Consolas, monospace; }
#panel .kind { color: var(--muted); font-size: 12px; margin-bottom: 12px; }
.ev { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; }
.ev .loc { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: var(--accent);
  cursor: pointer; }
.ev .loc:hover { text-decoration: underline; }
.ev .role { color: var(--muted); font-size: 11px; margin-left: 8px; }
.ev pre { margin: 8px 0 0; background: var(--code-bg); border-radius: 8px;
  padding: 8px 10px; font-size: 11.5px; overflow-x: auto; line-height: 1.5; }
.ev pre .ln { color: var(--muted); user-select: none; padding-right: 10px; }
#panel .placeholder { color: var(--muted); font-size: 13px; line-height: 1.8; }
footer { border-top: 1px solid var(--line); padding: 20px 22px; }
footer h2 { font-size: 15px; }
table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 600; }
td code, th code { font-family: ui-monospace, Consolas, monospace; }
td .v { font-size: 11px; padding: 1px 8px; border-radius: 999px; }
td .v.backed { background: rgba(5,150,105,.12); color: var(--ok); }
td .v.disclosed { background: rgba(217,119,6,.14); color: var(--warn); }
td .v.unbacked, td .v.broken { background: rgba(220,38,38,.12); color: #dc2626; }
td .loc-link { color: var(--accent); text-decoration: none; }
td .loc-link:hover, a.loc-link:hover { text-decoration: underline; }
a.loc { color: var(--accent); cursor: pointer; }
.receipt { color: var(--muted); font-size: 12.5px; line-height: 1.8; }

/* SVG theming (viewer runtime) */
.topo-svg { background: transparent; }
.diagram-title { fill: var(--ink); font-size: 22px; font-weight: 700; }
.diagram-sub { fill: var(--muted); font-size: 12px; }
.group-box { fill: rgba(96,165,250,.06); stroke: rgba(96,165,250,.4); stroke-dasharray: 6 4; }
.group-label { fill: var(--muted); font-size: 11px; font-weight: 600; }
.node-box { fill: var(--node-fill); stroke: var(--node-stroke); stroke-width: 1.4; }
.node:hover .node-box, .node:focus .node-box { stroke: var(--accent); stroke-width: 2; }
.node.selected .node-box { stroke: var(--accent); stroke-width: 2.4; }
.node-stripe { fill: var(--muted); }
.kind-top .node-stripe { fill: var(--ok); }
.kind-ifc .node-stripe { fill: #0891b2; }
.kind-prim .node-stripe { fill: #7c3aed; }
.kind-prim .node-box, .kind-unk .node-box { stroke-dasharray: 5 3; }
.kind-unk .node-stripe { fill: var(--muted); }
.node.disclosed .node-box { stroke-dasharray: 5 3; stroke: var(--warn); }
.node-label { fill: var(--ink); font-size: 14px; font-weight: 600; }
.node-sub { fill: var(--muted); font-size: 10.5px; font-family: ui-monospace, Consolas, monospace; }
.node-chip { fill: var(--muted); font-size: 10px; }
.node-warn { fill: var(--warn); font-size: 12px; }
.edge-line { fill: none; stroke: var(--edge); stroke-width: 1.6; marker-end: url(#topo-arrow); }
.edge:hover .edge-line, .edge.selected .edge-line { stroke: var(--accent); stroke-width: 2.4; }
.edge.cross .edge-line { stroke-dasharray: 7 5; stroke: #7c6ff0; stroke-width: 1.2; opacity: .7; }
.diagram-legend { fill: var(--muted); font-size: 11px; }
.edge-label { fill: var(--muted); font-size: 10px; font-family: ui-monospace, Consolas, monospace; }
.conn-line { fill: none; stroke-width: 1.4; stroke-dasharray: 3 3; }
.conn.kind-data .conn-line { stroke: var(--accent); }
.conn.kind-clock .conn-line { stroke: var(--warn); }
.conn.kind-reset .conn-line { stroke: #dc2626; }
.conn.kind-handshake .conn-line { stroke: var(--ok); }
.conn.kind-other .conn-line { stroke: var(--muted); }
.conn-label { fill: var(--muted); font-size: 9.5px; font-family: ui-monospace, Consolas, monospace; }
.arrow { fill: var(--edge); }
.node.dim { opacity: .14; }
.edge.dim, .conn.dim { opacity: .08; }
@media (prefers-color-scheme: dark) { html:not(.light) { /* vars already cascade */ } }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(title)}</h1>
  <span class="badge ${receipt && receipt.ok ? 'ok' : 'warn'}" id="verify-badge"></span>
  <span class="spacer"></span>
  <input id="search" type="search" placeholder="搜索模块 / 文件…">
  <button id="theme" title="切换深浅主题">🌓</button>
</header>
<main>
  <div id="stage">${svg}</div>
  <aside id="panel"><div class="placeholder">点击图中的模块或连线查看源码证据。<br>每个元素的 file:line 都可回溯到真实 RTL。</div></aside>
</main>
<footer>
  <h2>模块索引（代码库索引）</h2>
  <table id="index-table">
    <thead><tr><th>元素</th><th>类型</th><th>证据位置</th><th>校验</th></tr></thead>
    <tbody></tbody>
  </table>
  <p class="receipt" id="receipt-line"></p>
</footer>
<script>
const INDEX = ${indexJson};
const badge = document.getElementById('verify-badge');
const receiptLine = document.getElementById('receipt-line');
if (${JSON.stringify(!!receipt)}) {
  const m = ${JSON.stringify(receipt ? receipt.metrics : null)};
  badge.textContent = m.backed + '/' + m.elements + ' 已溯源' + (m.unbacked + m.broken ? ' · ⚠ ' + (m.unbacked + m.broken) + ' 项未通过' : '');
  receiptLine.textContent = 'verify 回执 · 幻觉风险 ' + (m.hallucinationRisk * 100).toFixed(2) + '% · backed ' + m.backed + ' / disclosed ' + m.disclosed + ' / unbacked ' + m.unbacked + ' / broken ' + m.broken + ' · 扫描于 ' + ${JSON.stringify(receipt ? receipt.scannedAt : '')};
} else {
  badge.textContent = '未验证';
}

const tbody = document.querySelector('#index-table tbody');
for (const el of INDEX.elements) {
  const tr = document.createElement('tr');
  const v = el.verdict;
  const locHtml = el.url
    ? '<a class="loc-link" href="' + el.url + '" target="_blank" rel="noopener"><code>' + esc(el.primaryLoc || '—') + '</code></a>'
    : '<code>' + esc(el.primaryLoc || '—') + '</code>';
  tr.innerHTML = '<td><code>' + esc(el.label) + '</code></td><td>' + esc(el.kindLabel) + '</td>' +
    '<td>' + locHtml + '</td>' +
    '<td><span class="v ' + v + '">' + v + '</span></td>';
  tr.style.cursor = 'pointer';
  tr.addEventListener('click', () => selectElement(el.id));
  tbody.appendChild(tr);
}

function esc(s) { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; }

const panel = document.getElementById('panel');
const stage = document.getElementById('stage');

function selectElement(id) {
  const el = INDEX.byId[id];
  if (!el) return;
  document.querySelectorAll('.selected').forEach((n) => n.classList.remove('selected'));
  const shape = stage.querySelector('[data-id="' + cssEscape(id) + '"]');
  if (shape) {
    shape.classList.add('selected');
    shape.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  }
  let html = '<h2>' + esc(el.label) + '</h2><div class="kind">' + esc(el.kindLabel) +
    (el.extra ? ' · ' + esc(el.extra) : '') + ' · <span class="v ' + el.verdict + '">' + el.verdict + '</span></div>';
  if (el.detail) html += '<div class="kind" style="margin-bottom:10px">' + esc(el.detail) + '</div>';
  for (const ev of el.evidence) {
    const locText = esc(ev.file) + ':' + ev.line;
    const locHtml = ev.url
      ? '<a class="loc loc-link" href="' + ev.url + '" target="_blank" rel="noopener" title="在 GitHub 打开源码">' + locText + ' ↗</a>'
      : '<span class="loc" data-loc="' + locText + '" title="复制">' + locText + '</span>';
    html += '<div class="ev">' + locHtml + '<span class="role">' + esc(ev.role) + '</span>';
    if (ev.snippet) html += '<pre>' + ev.snippet.map((l) => '<span class="ln">' + l.n + '</span>' + esc(l.t)).join('\\n') + '</pre>';
    html += '</div>';
  }
  if (el.discloseReason) html += '<div class="kind" style="color:var(--warn)">⚠ 已披露未验证: ' + esc(el.discloseReason) + '</div>';
  panel.innerHTML = html;
  panel.querySelectorAll('.loc').forEach((loc) => {
    loc.addEventListener('click', () => navigator.clipboard && navigator.clipboard.writeText(loc.dataset.loc));
  });
}

function cssEscape(v) { return (window.CSS && CSS.escape) ? CSS.escape(v) : v.replace(/["\\\\]/g, '\\\\$&'); }

stage.addEventListener('click', (e) => {
  const g = e.target.closest('[data-id]');
  if (g) selectElement(g.dataset.id);
});
stage.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const g = e.target.closest('[data-id]');
  if (g) selectElement(g.dataset.id);
});

document.getElementById('search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  stage.querySelectorAll('.node').forEach((n) => {
    const el = INDEX.byId[n.dataset.id];
    const hit = !q || (el && (el.label.toLowerCase().includes(q) || (el.primaryLoc || '').toLowerCase().includes(q)));
    n.classList.toggle('dim', !hit);
  });
  stage.querySelectorAll('.edge, .conn').forEach((n) => n.classList.toggle('dim', !!q));
});

const themeBtn = document.getElementById('theme');
const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
if (prefersDark) document.documentElement.classList.add('dark');
themeBtn.addEventListener('click', () => document.documentElement.classList.toggle('dark'));
</script>
</body>
</html>`;
}

function buildElementIndex(spec, snippets, receipt) {
  const verdicts = new Map((receipt?.rows || []).map((r) => [r.element, r.verdict]));
  const details = new Map((receipt?.rows || []).map((r) => [r.element, r.detail]));
  const disclosed = new Map((spec.meta?.disclosed_unverified || []).map((d) => [d.id, d.reason]));
  const kindLabels = { module: 'module', interface: 'interface', primitive: 'primitive', top: 'top', unknown: 'unknown' };
  const gh = spec.meta?.project?.github || null;
  const url = (file, line) => (gh && file && Number.isInteger(line) && line > 0 ? githubBlobUrl(gh, file, line) : null);

  const elements = [];
  const byId = {};
  const push = (el) => { elements.push(el); byId[el.id] = el; };

  for (const node of spec.nodes || []) {
    push({
      id: node.id, label: node.label, kind: 'node',
      kindLabel: kindLabels[node.kind] || node.kind,
      extra: node.portCount != null ? node.portCount + ' 端口' : null,
      primaryLoc: `${node.file}:${node.line}`,
      url: url(node.file, node.line),
      verdict: verdicts.get(node.id) || 'unbacked',
      detail: details.get(node.id) || null,
      discloseReason: disclosed.get(node.id) || null,
      evidence: (node.evidence || []).map((ev) => withSnippet(ev, snippets, url)),
    });
  }
  const nodeLabel = new Map((spec.nodes || []).map((n) => [n.id, n.label]));
  for (const edge of spec.instances || []) {
    push({
      id: edge.id, label: `${nodeLabel.get(edge.parent)} → ${nodeLabel.get(edge.child)} (${edge.label})`,
      kind: 'instance', kindLabel: '例化',
      primaryLoc: `${edge.file}:${edge.line}`,
      url: url(edge.file, edge.line),
      verdict: verdicts.get(edge.id) || 'unbacked',
      detail: details.get(edge.id) || null,
      discloseReason: disclosed.get(edge.id) || null,
      evidence: (edge.evidence || []).map((ev) => withSnippet(ev, snippets, url)),
    });
  }
  for (const conn of spec.connections || []) {
    push({
      id: conn.id, label: `${conn.signal} (${nodeLabel.get(conn.from)} → ${nodeLabel.get(conn.to)})`,
      kind: 'connection', kindLabel: '连接 · ' + conn.kind,
      primaryLoc: `${conn.file}:${conn.line}`,
      url: url(conn.file, conn.line),
      verdict: verdicts.get(conn.id) || 'unbacked',
      detail: details.get(conn.id) || null,
      discloseReason: disclosed.get(conn.id) || null,
      evidence: (conn.evidence || [{ file: conn.file, line: conn.line, role: 'signal' }]).map((ev) => withSnippet(ev, snippets, url)),
    });
  }
  for (const group of spec.groups || []) {
    push({
      id: group.id, label: group.label, kind: 'group', kindLabel: '分组',
      primaryLoc: group.evidence?.[0]?.file ?? '—',
      url: null,
      verdict: verdicts.get(group.id) || 'unbacked',
      detail: details.get(group.id) || null,
      discloseReason: null,
      evidence: [],
    });
  }
  return { elements, byId };
}

function withSnippet(ev, snippets, url) {
  const snip = snippets ? snippets[`${ev.file}:${ev.line}`] || null : null;
  return { ...ev, snippet: snip, url: url ? url(ev.file, ev.line) : null };
}
