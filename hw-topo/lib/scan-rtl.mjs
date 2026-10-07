// Standalone Verilog / SystemVerilog evidence indexer.
//
// The anti-hallucination kernel of hw-topo: every topology claim must trace
// back to a `file:line` produced here. The scanner is deliberately
// conservative — it extracts only constructs that a tolerant regex can pin
// to an exact line (module/interface declarations, port directions,
// instantiations) and reports everything else as `unresolved` rather than
// guessing. No parsing claim is ever invented.
//
// Output: an evidence bundle (JSON) that `derive` and `verify` consume.

import fs from 'node:fs';
import path from 'node:path';
import { lineOfIndex, sha256Hex, toRelativePosix } from './util.mjs';

export const RTL_EXTENSIONS = new Set(['.v', '.sv', '.vh', '.svh']);

const SKIP_DIRS = new Set([
  '.git', '.svn', 'node_modules', '.DS_Store', 'build', 'work', 'sim_build',
]);

// Common FPGA vendor primitives / simulation models. Anything instantiated
// but not declared in the scanned tree lands in one of these buckets.
const VENDOR_PRIMITIVES = new Set([
  // Lattice iCE40 / ECP5 (eLinx)
  'SB_IO', 'SB_GB_IO', 'SB_RAM256x16', 'SB_RAM40_4K', 'SB_SPRAM256KA', 'SB_PLL40_PAD',
  'SB_PLL40_CORE', 'SB_HFOSC', 'SB_LFOSC', 'SB_RGBA_DRV', 'SB_LED_DRV_CUR',
  'SB_I2C', 'SB_SPI', 'SB_MAC16', 'SB_DF_80', 'SB_DFFS', 'SB_DFFE', 'SB_CARRY',
  'ECO_DAC', 'DP16KD', 'MULT18X18D', 'PLL', 'GSR', 'ODDR', 'IDDR',
  // Xilinx
  'BUFG', 'BUFGCE', 'BUFGCTRL', 'IBUF', 'OBUF', 'IOBUF', 'MMCM', 'PLLE2', 'PLLE3',
  'PLL_ADV', 'IBUFDS', 'OBUFDS', 'IDELAYCTRL', 'IODELAY', 'IDELAYE2',
  'BRAM_SDP', 'RAM32M', 'RAM64M', 'RAMB18E1', 'RAMB36E1', 'DSP48E1', 'DSP48E2',
  'XADC', 'STARTUP', 'ICAPE3', 'MMCME2', 'MMCME3', 'MMCME4',
  // Altera / Intel
  'altpll', 'altsyncram', 'alt_inbuf', 'alt_outbuf', 'cycloneiii_pll',
  // Simulation / formal models
  'glbl', 'SIM_PRIM', 'UDP_pd', 'dut_model',
]);

const KEYWORD_TYPES = new Set([
  'if', 'else', 'for', 'while', 'case', 'casex', 'casez', 'always', 'always_comb',
  'always_ff', 'always_latch', 'initial', 'final', 'assert', 'assume', 'cover',
  'wait', 'forever', 'repeat', 'function', 'task', 'module', 'macromodule',
  'primitive', 'generate', 'endgenerate', 'return', 'disable', 'begin', 'end',
  'assign', 'deassign', 'force', 'release', 'release', 'posedge', 'negedge',
  'or', 'and', 'not', 'buf', 'xor', 'nand', 'nor', 'xnor', 'signed', 'unsigned',
  'logic', 'wire', 'reg', 'integer', 'real', 'time', 'genvar', 'typedef',
  'class', 'struct', 'union', 'enum', 'package', 'program', 'interface',
  'clocking', 'modport', 'property', 'sequence', 'covergroup', 'randcase',
  'randsequence', 'expect', 'restrict', 'unique', 'priority', 'inside',
  'with', 'new', 'this', 'super', 'scope', 'std', 'void', 'shortint', 'longint',
  'byte', 'bit', 'int', 'float', 'event', 'chandle', 'string', 'type',
]);

function isPosixSeparator(ch) {
  return ch === '/';
}
void isPosixSeparator;

/**
 * Replace comments, string literal *contents*, and preprocessor directive
 * lines with spaces, preserving length and every newline so indexes stay
 * line-accurate. Directive lines (first non-space char is a backtick) are
 * masked whole: `` `ifdef MACRO `` followed by a task call must never fuse
 * into a fake instantiation, and `` `define`` bodies are not source truth.
 */
export function maskCommentsAndStrings(text) {
  // Pass 1: directive lines -> spaces (keep newlines).
  let masked = text.replace(/^[ \t]*`[^\n]*/gm, (line) => line.replace(/[^\n]/g, ' '));
  const out = masked.split('');
  let i = 0;
  const n = masked.length;
  while (i < n) {
    const c = masked[i];
    const next = i + 1 < n ? masked[i + 1] : '';
    if (c === '/' && next === '/') {
      while (i < n && masked[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (c === '/' && next === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < n && !(masked[i] === '*' && masked[i + 1] === '/')) {
        if (masked[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    if (c === '"') {
      out[i] = ' ';
      i++;
      while (i < n && masked[i] !== '"') {
        if (masked[i] === '\\') { out[i] = ' '; i++; if (i < n && masked[i] !== '\n') out[i] = ' '; i++; continue; }
        if (masked[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) { out[i] = ' '; i++; }
      continue;
    }
    i++;
  }
  return out.join('');
}

/** Find the index of the closing bracket matching the one at `openIndex`. */
export function matchBracket(masked, openIndex) {
  const open = masked[openIndex];
  const close = open === '(' ? ')' : open === '[' ? ']' : open === '{' ? '}' : null;
  if (!close) return -1;
  let depth = 0;
  for (let i = openIndex; i < masked.length; i++) {
    const c = masked[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a comma list at depth 0 relative to `()`/`[]`/`{}`. */
export function splitTopLevel(masked, from, to) {
  const parts = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(masked.slice(start, i));
      start = i + 1;
    }
  }
  if (start < to) parts.push(masked.slice(start, to));
  return parts.map((s) => s.trim()).filter(Boolean);
}

function lastIdentifier(chunk) {
  const ids = chunk.match(/[A-Za-z_][\w$]*/g);
  return ids ? ids[ids.length - 1] : null;
}

/**
 * Extract declared modules and interfaces from one masked source.
 * Returns declaration records with exact spans (declaration line..end line).
 */
export function extractDeclarations(masked) {
  const declRe = /\b(module|macromodule|interface)\s+(?:automatic\s+)?([A-Za-z_][\w$]*)/g;
  const declarations = [];
  let m;
  while ((m = declRe.exec(masked)) !== null) {
    const kind = m[1] === 'interface' ? 'interface' : 'module';
    const name = m[2];
    // `endmodule` must not re-trigger: the regex anchors on the keyword
    // followed by a name, and `endmodule foo` is not valid, but guard anyway.
    const before = masked.slice(Math.max(0, m.index - 3), m.index);
    if (kind === 'module' && before === 'end') continue;
    if (kind === 'interface') {
      // skip `virtual interface`, `interface class`, `export interface`
      const prev = masked.slice(Math.max(0, m.index - 12), m.index);
      if (/\b(virtual|export)\s*$/.test(prev)) continue;
      if (masked.slice(m.index, m.index + 80).startsWith(`interface ${name}`) &&
          /^\s*(class|\.)/.test(masked.slice(m.index + m[0].length, m.index + m[0].length + 12))) {
        continue;
      }
    }
    const endKeyword = kind === 'interface' ? 'endinterface' : 'endmodule';
    const endRe = new RegExp(`\\b${endKeyword}\\b`, 'g');
    endRe.lastIndex = m.index;
    const endMatch = endRe.exec(masked);
    // Header port list: the first `(` that is NOT a `#(` parameter block.
    // `module x #(params) (ports)` — skip the param block, take the next one.
    let headerOpen = -1;
    {
      let idx = masked.indexOf('(', m.index);
      while (idx !== -1) {
        let j = idx - 1;
        while (j >= 0 && /\s/.test(masked[j])) j--;
        if (j >= 0 && masked[j] === '#') {
          const close = matchBracket(masked, idx);
          if (close === -1) break;
          idx = masked.indexOf('(', close + 1);
          continue;
        }
        headerOpen = idx;
        break;
      }
    }
    let headerEnd = -1;
    if (headerOpen !== -1) {
      const close = matchBracket(masked, headerOpen);
      if (close !== -1) headerEnd = close;
    }
    declarations.push({
      name,
      kind,
      declIndex: m.index,
      declLine: lineOfIndex(masked, m.index),
      headerOpen,
      headerEnd,
      endLine: endMatch ? lineOfIndex(masked, endMatch.index) : lineOfIndex(masked, masked.length),
    });
  }
  return declarations;
}

/**
 * Scan one file's masked text for modules, ports, params, instantiations.
 * All returned positions are exact indexes into `masked` (== `text` length).
 */
export function scanMaskedFile(masked) {
  const declarations = extractDeclarations(masked);
  // Assign span end indexes (index of `endmodule`/`endinterface`).
  const endReCache = [];
  for (const decl of declarations) {
    const endKeyword = decl.kind === 'interface' ? 'endinterface' : 'endmodule';
    const re = new RegExp(`\\b${endKeyword}\\b`, 'g');
    re.lastIndex = decl.declIndex + decl.name.length;
    const em = re.exec(masked);
    decl._spanEndIndex = em ? em.index + em[0].length : masked.length;
    endReCache.push(decl._spanEndIndex);
  }

  const modules = [];
  for (const decl of declarations) {
    // Header port names.
    let portNames = [];
    if (decl.headerOpen !== -1 && decl.headerEnd > decl.headerOpen) {
      const list = masked.slice(decl.headerOpen + 1, decl.headerEnd);
      for (const chunk of splitTopLevel(list, 0, list.length)) {
        const name = lastIdentifier(chunk.replace(/^\s*\.[A-Za-z_][\w$]*/, ''));
        if (name && !KEYWORD_TYPES.has(name)) {
          const dm = /(?:^|\s)(input|output|inout)\b/.exec(chunk);
          portNames.push({ name, direction: dm ? dm[1] : null });
        }
      }
    }
    // Direction resolution over the span (non-ANSI + inherits).
    const dirRe = /\b(input|output|inout)\b([^;()]{0,400})/g;
    dirRe.lastIndex = decl.declIndex;
    let dm;
    while ((dm = dirRe.exec(masked)) !== null) {
      if (dm.index > decl._spanEndIndex) break;
      for (const id of dm[2].match(/[A-Za-z_][\w$]*/g) || []) {
        const existing = portNames.find((p) => p.name === id);
        if (existing && !existing.direction) existing.direction = dm[1];
      }
    }
    // Parameters (header `#(parameter ...)` + body `parameter ...`).
    const params = [];
    const paramRe = /\bparameter\b(?:\s+\[[^\]]*\])?\s+([A-Za-z_][\w$]*)\s*=/g;
    paramRe.lastIndex = decl.declIndex;
    let pm;
    while ((pm = paramRe.exec(masked)) !== null) {
      if (pm.index > decl._spanEndIndex) break;
      if (!params.includes(pm[1])) params.push(pm[1]);
    }
    modules.push({
      name: decl.name,
      kind: decl.kind,
      line: decl.declLine,
      endLine: decl.endLine,
      ports: portNames.slice(0, 128),
      portCount: portNames.length,
      params: params.slice(0, 64),
      _spanEndIndex: decl._spanEndIndex,
      _headerEnd: decl.headerEnd,
    });
  }

  // Instantiations: TYPE [#(...)] INSTANCE ( ... ) ;
  // Hand-rolled scanner: find a candidate identifier, an optional param
  // block, then an instance identifier and an opened connection list,
  // and require `;` after the closing paren.
  const instantiations = [];
  const idRe = /[A-Za-z_][\w$]*/g;
  let idm;
  while ((idm = idRe.exec(masked)) !== null) {
    const type = idm[0];
    if (KEYWORD_TYPES.has(type)) continue;
    // Must not be a macro usage (`` `NAME ``), a hierarchical name (`a.b`)
    // or package scope (`pkg::b`).
    const prevChar = idm.index > 0 ? masked[idm.index - 1] : '';
    if (prevChar === '.' || prevChar === '$' || prevChar === '`') continue;
    let i = idm.index + type.length;
    // Optional parameter block.
    while (i < masked.length && /\s/.test(masked[i])) i++;
    if (masked[i] === '#') {
      i++;
      while (i < masked.length && /\s/.test(masked[i])) i++;
      if (masked[i] !== '(') continue; // `#` not followed by `(`: not an instantiation
      const closePar = matchBracket(masked, i);
      if (closePar === -1) continue;
      i = closePar + 1;
      while (i < masked.length && /\s/.test(masked[i])) i++;
    }
    // Instance identifier.
    const instMatch = /^[A-Za-z_][\w$]*/.exec(masked.slice(i));
    if (!instMatch) continue;
    const inst = instMatch[0];
    if (KEYWORD_TYPES.has(inst)) continue;
    i += inst.length;
    while (i < masked.length && /\s/.test(masked[i])) i++;
    if (masked[i] !== '(') continue;
    const closeParen = matchBracket(masked, i);
    if (closeParen === -1) continue;
    // Require the statement to end with `;` (function/task calls excluded).
    let j = closeParen + 1;
    while (j < masked.length && /\s/.test(masked[j])) j++;
    if (masked[j] !== ';') continue;
    // Attribute the instantiation to the innermost enclosing declaration.
    const owner = findEnclosing(declarations, idm.index);
    if (!owner) continue;
    // Skip module headers themselves (port decls inside the header parens).
    if (owner.headerOpen !== -1 && owner.headerEnd > owner.headerOpen &&
        idm.index > owner.headerOpen && idm.index < owner.headerEnd) {
      continue;
    }
    instantiations.push({
      parent: owner.name,
      type,
      instance: inst,
      line: lineOfIndex(masked, idm.index),
      lineEnd: lineOfIndex(masked, closeParen),
      _spanEndIndex: owner._spanEndIndex,
    });
    idRe.lastIndex = closeParen + 1;
  }

  return { modules, instantiations };
}

function findEnclosing(declarations, index) {
  let best = null;
  for (const decl of declarations) {
    if (index >= decl.declIndex && index < decl._spanEndIndex) {
      if (!best || decl.declIndex > best.declIndex) best = decl;
    }
  }
  return best;
}

function walkRtlFiles(root, out, budget) {
  if (out.length > budget) return out; // early stop: huge trees fail fast
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkRtlFiles(full, out, budget);
    else if (RTL_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(full);
    if (out.length > budget) return out;
  }
  return out;
}

/**
 * Scan an RTL tree into an evidence bundle.
 *
 * @param {string} root absolute path to the RTL root
 * @param {{maxFiles?: number}} [opts]
 */
export function scanRtl(root, opts = {}) {
  const absRoot = path.resolve(root);
  if (!fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) {
    throw new Error(`RTL root is not a directory: ${absRoot}`);
  }
  const maxFiles = opts.maxFiles ?? 4000;
  const files = walkRtlFiles(absRoot, [], maxFiles + 1);
  if (files.length > maxFiles) {
    throw new Error(`RTL tree exceeds ${maxFiles} files (stopped the walk early); narrow the root`);
  }
  files.sort();

  const bundle = {
    tool: 'hw-topo scan-rtl',
    schema: 1,
    root: absRoot,
    rootSeparator: path.sep,
    scannedAt: new Date().toISOString(),
    files: [],
    modules: [],
    instantiations: [],
    unresolved: [],
    stats: { files: 0, modules: 0, instantiations: 0, unresolvedVendor: 0, unresolvedUnknown: 0 },
  };

  const fileIndex = new Map(); // abs path -> {masked, rel}
  for (const file of files) {
    const buf = fs.readFileSync(file);
    const text = buf.toString('utf8');
    const masked = maskCommentsAndStrings(text);
    const rel = toRelativePosix(absRoot, file);
    fileIndex.set(file, { masked, rel });
    bundle.files.push({ path: rel, bytes: buf.length, lines: text.split('\n').length, sha256: sha256Hex(buf) });
  }

  const declared = new Map(); // module name -> module record (first wins)
  const moduleList = [];
  for (const [file, { masked, rel }] of fileIndex) {
    const { modules, instantiations } = scanMaskedFile(masked);
    for (const mod of modules) {
      const record = {
        name: mod.name, kind: mod.kind, file: rel,
        line: mod.line, endLine: mod.endLine,
        portCount: mod.portCount, ports: mod.ports, params: mod.params,
      };
      moduleList.push(record);
      if (!declared.has(mod.name)) declared.set(mod.name, record);
    }
    for (const inst of instantiations) {
      bundle.instantiations.push({
        parent: inst.parent, type: inst.type, instance: inst.instance,
        file: rel, line: inst.line,
      });
    }
  }

  // Unresolved types: instantiated but never declared in the tree.
  const instantiatedTypes = new Map();
  for (const inst of bundle.instantiations) {
    if (!instantiatedTypes.has(inst.type)) instantiatedTypes.set(inst.type, []);
    instantiatedTypes.get(inst.type).push(inst);
  }
  for (const [type, insts] of instantiatedTypes) {
    if (declared.has(type)) continue;
    const classification = VENDOR_PRIMITIVES.has(type) ? 'vendor-primitive' : 'unknown';
    bundle.unresolved.push({
      type, classification,
      file: insts[0].file, line: insts[0].line, count: insts.length,
      parents: [...new Set(insts.map((i) => i.parent))].slice(0, 16),
    });
    if (classification === 'vendor-primitive') bundle.stats.unresolvedVendor++;
    else bundle.stats.unresolvedUnknown++;
  }

  // Top / testbench heuristic: declared but never instantiated.
  const instantiated = new Set(bundle.instantiations.map((i) => i.type));
  for (const record of moduleList) {
    if (!instantiated.has(record.name) && !declared.has(record.name)) continue;
    record.role = instantiated.has(record.name) ? 'leaf-or-mid' : 'top';
  }

  bundle.modules = moduleList;
  bundle.stats.files = bundle.files.length;
  bundle.stats.modules = moduleList.length;
  bundle.stats.instantiations = bundle.instantiations.length;
  return bundle;
}

export { VENDOR_PRIMITIVES };
