// Shared helpers: hashing, path handling, line lookup, atomic writes.
// Zero runtime dependencies — Node builtins only, so the skill works in any
// DSH profile without `npm install`.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** POSIX-style, root-relative path for evidence pointers. */
export function toRelativePosix(root, file) {
  const rel = path.relative(root, file);
  return rel.split(path.sep).join('/');
}

/**
 * Resolve a spec-authored relative path and enforce containment inside
 * `root`. Returns the absolute path, or null when the path escapes the root
 * (absolute, backslash, drive letter, NUL, or any `..` that resolves
 * outside). Evidence must never read outside the scanned tree.
 */
export function resolveInsideRoot(root, relFile) {
  if (typeof relFile !== 'string' || !relFile || relFile.includes('\0') ||
      relFile.includes('\\') || path.isAbsolute(relFile) || /^[A-Za-z]:/.test(relFile)) {
    return null;
  }
  const abs = path.resolve(root, relFile);
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

/** True when `relFile` is a root-relative POSIX path that stays inside root. */
export function isInsideRoot(root, relFile) {
  return resolveInsideRoot(root, relFile) !== null;
}

export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Index -> 1-based line number, counting '\n' before `index`.
 * Tabs and other characters are preserved; masked text keeps newlines so the
 * same function works on comment-stripped sources.
 */
export function lineOfIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/** Trimmed source line (1-based). Returns null when out of range. */
export function sourceLine(text, line) {
  const lines = text.split('\n');
  if (line < 1 || line > lines.length) return null;
  return (lines[line - 1] || '').trim();
}

export function isWithinSpan(line, span) {
  return line >= span.start && line <= span.end;
}

export function atomicWrite(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

export function fileStats(file) {
  const buf = fs.readFileSync(file);
  return {
    bytes: buf.length,
    lines: buf.toString('utf8').split('\n').length,
    sha256: sha256Hex(buf),
  };
}

export function nowIso() {
  return new Date().toISOString();
}

/** Short deterministic id from a string, e.g. `n-a1b2c3`. */
export function shortId(prefix, key) {
  return `${prefix}-${sha256Hex(key).slice(0, 10)}`;
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeXml(value) {
  return escapeHtml(value);
}

/**
 * Parse a JSON document, tolerating a leading UTF-8 BOM.
 *
 * Windows tooling writes BOMs routinely: PowerShell 5.1's
 * `Set-Content -Encoding UTF8`, Notepad's "UTF-8 with BOM", and several
 * editors all emit one. `JSON.parse` then fails with a cryptic
 * "Unexpected token '<invisible char>'", which reads to a user who hand-edited
 * a spec as "your file is broken" rather than "your file has an invisible
 * prefix". Stripping it is unambiguous, because U+FEFF is never valid at the
 * start of a JSON document. (Observed for real: a PowerShell-generated spec
 * was rejected during acceptance.)
 */
export function parseJson(text) {
  const body = typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return JSON.parse(body);
}
