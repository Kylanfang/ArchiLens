// Wiki page generator: the delivered topology as a codebase-index markdown
// page (Obsidian / GitHub flavored). Every row links back to source, so the
// wiki page doubles as the project's living module index.


import { githubBlobUrl } from './github.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Single source of truth for the tool version shown in the wiki frontmatter.
// A hardcoded literal here drifts the moment the package version moves, and a
// page that misreports which tool produced it is exactly the kind of
// "statements that disagree" this project exists to avoid. `unknown` is
// deliberately not a fabricated version number.
const SKILL_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();

/** One-line cross-check verdict, shared by the frontmatter, header and table. */
function crossCheckSummary(xc) {
  if (!xc) return 'not-run';
  if (!xc.checked) return 'not-checked';
  if (xc.counts?.coordinateMismatches) return `coordinate-mismatch(${xc.counts.coordinateMismatches})`;
  if ((xc.divergences || []).length) return `coverage-differs(${xc.divergences.length})`;
  return 'agree';
}

export function buildWikiMarkdown({ spec, receipt, svgFile, baseName }) {
  const meta = spec.meta || {};
  const gh = meta.project?.github || null;
  // Evidence link: GitHub permalink when the project came from `gh`, else a
  // repo-relative path that works in Obsidian/GitHub wikis.
  const loc = (file, line) => (gh ? githubBlobUrl(gh, file, line) : file);
  // Markdown-cell sanitizer: crafted labels/titles must not break tables or
  // smuggle raw HTML into wiki renderers (Obsidian renders markdown HTML).
  const cell = (v) => String(v ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\]\(/g, '] (') // neutralize markdown links (javascript: etc.)
    .replace(/\|/g, '\\|')
    .trim();
  const inlineTitle = (v) => cell(v).replace(/"/g, "'"); // frontmatter-safe
  const m = receipt?.metrics || { backed: 0, disclosed: 0, unbacked: 0, broken: 0, elements: 0, hallucinationRisk: 1 };
  // Cross-engine divergence report (opt-in). When present it belongs in the
  // frontmatter AND the header: a reader who sees only `verify: pass` must not
  // be left assuming two independent engines agreed when one never ran at all.
  const xc = receipt?.crossCheck ?? null;
  const lines = [];

  lines.push('---');
  lines.push(`title: "${inlineTitle(meta.title || 'RTL 拓扑')}"`);
  if (meta.project?.name) lines.push(`project: "${inlineTitle(meta.project.name)}"`);
  lines.push(`tool: hw-topo@${cell(SKILL_VERSION)}`);
  lines.push(`generated: ${new Date().toISOString()}`);
  lines.push(`verify: ${receipt?.ok ? 'pass' : 'FAIL'} (risk ${(m.hallucinationRisk * 100).toFixed(2)}%, backed ${m.backed}/${m.elements})`);
  if (xc) lines.push(`crosscheck: ${cell(crossCheckSummary(xc))}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${cell(meta.title || 'RTL 拓扑')}`);
  lines.push('');
  lines.push(`> 有图有真相:本页由 hw-topo 从 RTL 源码扫描生成,每个元素都可回溯到 \`file\`:\`line\` 级证据。`);
  lines.push(`> 交互版(点击查看证据面板): [[${baseName}.html]] · 矢量图: [[${baseName}.svg]]`);
  // Contract R6: a degraded evidence backend must be visible in the page
  // header, not only in the receipt table below.
  const provenance = receipt?.provenance ?? spec.meta?.derivedFrom?.provenance ?? null;
  if (provenance?.degraded) {
    lines.push(`> ⚠ **证据后端降级(${cell(provenance.backend)}):** ${cell(provenance.reason)}`);
  } else if (provenance) {
    lines.push(`> 证据后端:${cell(provenance.backend)}${provenance.tool?.version ? ` ${cell(provenance.tool.version)}` : ''}${provenance.evidenceSchema ? ` (\`${cell(provenance.evidenceSchema)}\`)` : ''}`);
  }
  if (xc) {
    if (!xc.checked) {
      lines.push(`> · **交叉核对未执行:** ${cell(xc.secondaryUnavailable)}`);
    } else if (xc.counts?.coordinateMismatches) {
      lines.push(`> ⚠ **交叉核对:坐标不一致(${xc.counts.coordinateMismatches} 处)** — ${cell(xc.primary)} 与 ${cell(xc.secondary)} 对同一批事实给出了不同行号,本页坐标不可信。详见「跨引擎核对」。`);
    } else if ((xc.divergences || []).length) {
      lines.push(`> · 交叉核对:${xc.divergences.length} 处覆盖差异(无坐标冲突),已分类披露。详见「跨引擎核对」。`);
    } else {
      lines.push(`> · 交叉核对:${cell(xc.primary)} 与 ${cell(xc.secondary)} 在全部共享事实上一致。`);
    }
  }
  lines.push('');
  if (svgFile) {
    lines.push(`![${cell(meta.title || 'topology')}](${svgFile})`);
    lines.push('');
  }

  lines.push('## 自检回执');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---|');
  lines.push(`| 溯源通过 (backed) | ${m.backed} / ${m.elements} |`);
  lines.push(`| 已披露未验证 (disclosed) | ${m.disclosed} |`);
  lines.push(`| 未溯源 (unbacked) | ${m.unbacked} ⚠ |`);
  lines.push(`| 证据失效 (broken) | ${m.broken} ⚠ |`);
  lines.push(`| 幻觉风险 | ${(m.hallucinationRisk * 100).toFixed(2)}% |`);
  lines.push(`| RTL 根目录 | \`${meta.project?.root || '?'}\` |`);
  if (receipt?.scannedAt) lines.push(`| 扫描时间 | ${receipt.scannedAt} |`);
  // R6: the evidence grade belongs in the receipt table too, next to the risk.
  if (provenance) {
    lines.push(`| 证据后端 | ${cell(provenance.backend)}${provenance.degraded ? ' ⚠ 降级' : ''}${provenance.tool?.version ? ` (v${cell(provenance.tool.version)})` : ''} |`);
    if (provenance.evidenceSchema) lines.push(`| 证据 schema | \`${cell(provenance.evidenceSchema)}\` |`);
    if (Object.keys(provenance.defines || {}).length) {
      lines.push(`| define 集 | \`${cell(Object.entries(provenance.defines).map(([k, v]) => `${k}=${v}`).join(' '))}\` |`);
    }
    if (provenance.degraded && provenance.reason) lines.push(`| 降级原因 | ${cell(provenance.reason)} |`);
  }
  if (gh) lines.push(`| GitHub 溯源 | [${gh.slug}@${gh.sha.slice(0, 10)}](https://github.com/${gh.slug}/tree/${gh.sha})${gh.tarballSha256 ? ` (tarball sha256 \`${gh.tarballSha256.slice(0, 16)}…\`)` : ''} |`);
  if (xc) {
    lines.push(`| 交叉核对 | ${cell(crossCheckSummary(xc))}${xc.checked ? ` (${cell(xc.primary)} vs ${cell(xc.secondary)})` : ''} |`);
    if (xc.checked && xc.counts) {
      const cats = Object.entries(xc.counts.byCategory || {}).map(([k, v]) => `${k}×${v}`).join(', ');
      lines.push(`| 分歧分类 | ${cats ? cell(cats) : '—'}${xc.truncated ? ' (已截断)' : ''} |`);
    }
    if (!xc.checked) lines.push(`| 核对未执行原因 | ${cell(xc.secondaryUnavailable)} |`);
  }
  lines.push('');

  const nodeById = new Map((spec.nodes || []).map((n) => [n.id, n]));
  const parentsByChild = new Map();
  for (const edge of spec.instances || []) {
    const label = nodeById.get(edge.parent)?.label ?? edge.parent;
    if (!parentsByChild.has(edge.child)) parentsByChild.set(edge.child, []);
    parentsByChild.get(edge.child).push(cell(`${label} (${edge.file}:${edge.line})`));
  }

  lines.push('## 模块索引');
  lines.push('');
  lines.push('| 模块 | 类型 | 声明位置 | 被例化于 | 端口 | 校验 |');
  lines.push('|---|---|---|---|---|---|');
  const verdicts = new Map((receipt?.rows || []).map((r) => [r.element, r.verdict]));
  for (const node of spec.nodes || []) {
    const parents = (parentsByChild.get(node.id) || []).slice(0, 4).join(', ') || '—';
    lines.push(`| \`${cell(node.label)}\` | ${cell(node.kind)} | [\`${node.file}:${node.line}\`](${loc(node.file, node.line)}) | ${parents} | ${node.portCount ?? '—'} | ${verdicts.get(node.id) || '?'} |`);
  }
  lines.push('');

  if ((spec.instances || []).length) {
    lines.push('## 例化关系');
    lines.push('');
    lines.push('| 父模块 | 子模块 | 实例 | 证据 | 校验 |');
    lines.push('|---|---|---|---|---|');
    for (const edge of spec.instances || []) {
      const p = nodeById.get(edge.parent)?.label ?? edge.parent;
      const c = nodeById.get(edge.child)?.label ?? edge.child;
      lines.push(`| \`${cell(p)}\` | \`${cell(c)}\` | \`${cell(edge.label)}\` | [\`${edge.file}:${edge.line}\`](${loc(edge.file, edge.line)}) | ${verdicts.get(edge.id) || '?'} |`);
    }
    lines.push('');
  }

  if ((spec.connections || []).length) {
    lines.push('## 信号级连接');
    lines.push('');
    lines.push('| 信号 | 类型 | 方向 | 证据 | 校验 |');
    lines.push('|---|---|---|---|---|');
    for (const conn of spec.connections || []) {
      const f = nodeById.get(conn.from)?.label ?? conn.from;
      const t = nodeById.get(conn.to)?.label ?? conn.to;
      lines.push(`| \`${cell(conn.signal)}\` | ${cell(conn.kind)} | ${cell(f)} → ${cell(t)} | [\`${conn.file}:${conn.line}\`](${loc(conn.file, conn.line)}) | ${verdicts.get(conn.id) || '?'} |`);
    }
    lines.push('');
  }

  const disclosed = meta.disclosed_unverified || [];
  if (disclosed.length) {
    lines.push('## 已披露的未验证项');
    lines.push('');
    lines.push('以下内容在源码中**没有**证据,仅按作者声明保留(图中以 ⚠ 虚线标出):');
    lines.push('');
    for (const d of disclosed) {
      const node = (spec.nodes || []).find((n) => n.id === d.id) || (spec.instances || []).find((e) => e.id === d.id);
      lines.push(`- \`${cell(node?.label ?? d.id)}\` — ${cell(d.reason)}`);
    }
    lines.push('');
  }

  if (xc?.checked && (xc.divergences || []).length) {
    lines.push('## 跨引擎核对(分歧披露)');
    lines.push('');
    lines.push(`图中事实来自主引擎 \`${cell(xc.primary)}\`;**见证引擎** \`${cell(xc.secondary)}\` 只用于比对,不会改动图。`);
    lines.push('');
    lines.push('`coordinate-mismatch` 表示两个引擎对同一批事实给出了**完全不同且不相交**的行号——那才是错位/基准错误;其余类别是已披露的覆盖差异,不构成坐标冲突。');
    lines.push('');
    lines.push('| 类别 | 对象 | 位置 | 主引擎行 | 见证行 | 说明 |');
    lines.push('|---|---|---|---|---|---|');
    for (const d of xc.divergences.slice(0, 60)) {
      const anchor = d.primaryLines?.[0] || d.secondaryLines?.[0] || 1;
      lines.push(`| ${cell(d.category)} | \`${cell(d.identity)}\` | [\`${cell(d.file)}\`](${loc(d.file, anchor)}) | ${cell((d.primaryLines || []).join(', ') || '—')} | ${cell((d.secondaryLines || []).join(', ') || '—')} | ${cell(d.detail || d.note)} |`);
    }
    if (xc.divergences.length > 60) {
      lines.push(`| … | | | | | 另有 ${xc.divergences.length - 60} 条,完整列表见回执 \`crossCheck\` |`);
    }
    lines.push('');
  }

  if ((receipt?.findings || []).length) {
    lines.push('## 校验发现(需修复)');
    lines.push('');
    for (const f of receipt.findings) {
      lines.push(`- **${cell(f.code)}** — ${cell(f.message)} → ${cell(f.supportedFixes.join(' / '))}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push(`*本页由 hw-topo 生成于 ${new Date().toISOString()}。重新生成:\`node bin/hw-topo.mjs deliver ${baseName}.topology.json --root <RTL根目录>\`*`);
  lines.push('');
  return lines.join('\n');
}
