// GitHub integration: repo discovery, pinned-commit tarball download, and a
// zero-dependency tar.gz extractor (USTAR/GNU/pax-tolerant).
//
// Network is used ONLY by the `gh` and `search` commands. The core pipeline
// (scan/derive/verify/deliver) stays offline. Evidence pins the exact commit
// SHA so every generated link is a permalink — 溯源不随上游漂移.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { sha256Hex } from './util.mjs';

const API = 'https://api.github.com';
const CODELOAD = 'https://codeload.githubusercontent.com';

function ghHeaders(close = false) {
  const headers = {
    'User-Agent': 'hw-topo/0.2 (DSH skill)',
    Accept: 'application/vnd.github+json',
  };
  // Keep-alive sockets trip a libuv assertion on Windows when the process
  // exits right after a fetch; ask the server to close instead.
  if (close) headers.Connection = 'close';
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function ghFetch(url) {
  const res = await fetch(url, { headers: ghHeaders(true), redirect: 'follow' });
  return res;
}

async function ghJson(urlPath) {
  const res = await ghFetch(`${API}${urlPath}`);
  if (res.status === 404) throw new Error(`GitHub: not found — ${urlPath}`);
  if (res.status === 403) throw new Error('GitHub: rate limited (60 req/h unauthenticated). Set GITHUB_TOKEN to raise the limit.');
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status} on ${urlPath}`);
  return res.json();
}

export async function searchRepos(query, limit = 8) {
  // Parens-grouped OR language filters return 0 on this endpoint; default to
  // a single language filter unless the caller supplied their own.
  const q = query.includes('language:')
    ? query
    : `${query} language:verilog`;
  const data = await ghJson(`/search/repositories?q=${encodeURIComponent(q)}&per_page=${Math.min(50, Math.max(1, limit))}&sort=stars`);
  return (data.items || []).map((r) => ({
    slug: r.full_name,
    description: r.description,
    stars: r.stargazers_count,
    language: r.language,
    defaultBranch: r.default_branch,
    updatedAt: r.updated_at,
  }));
}

export async function repoMeta(slug) {
  return ghJson(`/repos/${slug}`);
}

/** Resolve any ref (branch/tag/sha-prefix) to a full commit SHA. */
export async function resolveCommit(slug, ref) {
  const commit = await ghJson(`/repos/${slug}/commits/${encodeURIComponent(ref)}`);
  if (!commit.sha) throw new Error(`GitHub: no commit for ${slug}@${ref}`);
  return commit.sha;
}

/**
 * Fetch a binary body. Node fetch first; on connect failure fall back to
 * `curl -sSL` — some hosts route github.com fine for curl but not for
 * Node's fetch (observed on Windows + Git Bash setups behind filtered DNS).
 */
async function fetchBuffer(url) {
  const headers = ghHeaders(true);
  try {
    const res = await fetch(url, { headers, redirect: 'follow' });
    if (res.ok) {
      const declared = Number(res.headers.get('content-length') || 0);
      if (declared > 600 * 1024 * 1024) throw new Error(`body too large (${declared}B)`);
      return Buffer.from(await res.arrayBuffer());
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (fetchError) {
    try {
      const out = execFileSync('curl', ['-sSL', '--fail', '--max-time', '180', '-A', headers['User-Agent'], url], {
        encoding: 'buffer',
        maxBuffer: 600 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (out.length > 0) return out;
      throw new Error('curl returned empty body');
    } catch (curlError) {
      throw new Error(`fetch: ${fetchError.message}; curl: ${curlError.message}`);
    }
  }
}

/** Download the tarball for an exact SHA. Returns { buffer, sha256 }. */
export async function downloadTarball(slug, sha) {
  // Primary: codeload by SHA. Fallback: the github.com archive path (some
  // networks/CDN edges refuse the codeload domain outright).
  const urls = [
    `${CODELOAD}/${slug}/tar.gz/${sha}`,
    `https://github.com/${slug}/archive/${sha}.tar.gz`,
  ];
  let lastError = null;
  for (const url of urls) {
    try {
      const buffer = await fetchBuffer(url);
      if (buffer.length < 1024) {
        lastError = new Error(`suspiciously small body (${buffer.length}B) from ${new URL(url).host}`);
        continue;
      }
      return { buffer, sha256: sha256Hex(buffer) };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`tarball download failed for ${slug}@${sha.slice(0, 10)}: ${lastError?.message}`);
}

// ---------------------------------------------------------------------------
// tar.gz extraction (USTAR/GNU/pax-tolerant, traversal-safe)

function fieldStr(header, start, length) {
  const slice = header.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? length : nul).toString('utf8').replace(/\s+$/, '');
}

function fieldOctal(header, start, length) {
  const raw = fieldStr(header, start, length).trim();
  return raw ? parseInt(raw, 8) || 0 : 0;
}

/** Reject absolute paths, drive letters, NTFS ADS colons, and `..` segments. */
function sanitizeMember(rel) {
  const posix = rel.split(path.sep).join('/');
  if (posix.startsWith('/') || posix.includes('\\') || posix.includes(':') || /^[A-Za-z]:/.test(posix)) {
    throw new Error(`tar member escapes extraction root: ${rel}`);
  }
  const segs = posix.split('/');
  if (segs.some((s) => s === '..')) throw new Error(`tar member escapes extraction root: ${rel}`);
  return segs.filter((s) => s && s !== '.').join('/');
}

/** codeload tarballs nest under `<repo>-<ref>/`; strip that one segment. */
function stripTopDir(posix) {
  const i = posix.indexOf('/');
  return i === -1 ? posix : posix.slice(i + 1);
}

const MAX_FILES = 20000;
const MAX_TOTAL_BYTES = 600 * 1024 * 1024;
const MAX_TAR_BYTES = 1500 * 1024 * 1024; // decompressed bomb cap

/**
 * Extract a tar.gz buffer into destDir (created as needed).
 * Returns the number of regular files written. `opts.maxOutputLength` caps
 * the decompressed size (default 1.5 GiB) so gzip bombs fail cleanly.
 */
export function extractTarGz(tarGzBuffer, destDir, opts = {}) {
  if (tarGzBuffer.length > 600 * 1024 * 1024) {
    throw new Error(`tar: compressed archive too large (${tarGzBuffer.length}B)`);
  }
  const tar = zlib.gunzipSync(tarGzBuffer, { maxOutputLength: opts.maxOutputLength ?? MAX_TAR_BYTES });
  let off = 0;
  let files = 0;
  let total = 0;
  let longName = null;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive marker
    const rawName = fieldStr(header, 0, 100);
    const size = fieldOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] || 0);
    const prefix = fieldStr(header, 345, 155);
    let name = prefix ? `${prefix}/${rawName}` : rawName;
    off += 512;
    const contentEnd = off + size;
    if (contentEnd > tar.length) throw new Error('tar: truncated archive');
    const content = tar.subarray(off, contentEnd);
    off += Math.ceil(size / 512) * 512;

    if (typeflag === 'L') { // GNU long name applies to the next entry
      longName = content.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (typeflag === 'x' || typeflag === 'g') continue; // pax headers: skip
    if (longName) { name = longName; longName = null; }

    const rel = sanitizeMember(name);
    if (!rel) continue;
    const target = stripTopDir(rel);
    if (!target) continue;

    if (typeflag === '5') {
      fs.mkdirSync(path.join(destDir, ...target.split('/')), { recursive: true });
      continue;
    }
    if (typeflag !== '0' && typeflag !== '\0') continue; // symlinks/devices: skip
    if (++files > MAX_FILES) throw new Error(`tar: too many members (>${MAX_FILES})`);
    total += size;
    if (total > MAX_TOTAL_BYTES) throw new Error('tar: archive too large');
    const abs = path.join(destDir, ...target.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return files;
}

/** GitHub permalink for evidence. `sha` pins the exact source revision. */
export function githubBlobUrl(github, file, line) {
  const anchor = Number.isInteger(line) && line > 0 ? `#L${line}` : '';
  return `https://github.com/${github.slug}/blob/${github.sha}/${file}${anchor}`;
}
