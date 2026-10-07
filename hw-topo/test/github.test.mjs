// GitHub integration tests — all offline. The tar parser is exercised on a
// hand-built archive; link mapping is exercised through deliver outputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { extractTarGz, githubBlobUrl } from '../lib/github.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '..', 'bin', 'hw-topo.mjs');
const fixture = path.resolve(here, '..', 'examples', 'fixture', 'rtl');

function run(args) {
  return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

// ---- minimal USTAR builder (checksum field is written but the parser is
// deliberately lenient and never verifies it) ------------------------------
function tarHeader(name, size, typeflag = '0') {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 99), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('        ', 148); // checksum placeholder
  h.write(typeflag, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  return h;
}

function tarEntry(name, content, typeflag = '0') {
  const body = Buffer.from(content);
  const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  body.copy(padded);
  return Buffer.concat([tarHeader(name, body.length, typeflag), padded]);
}

function tarGz(entries) {
  return zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

test('extractTarGz unpacks nested files and strips the codeload top dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-tar-'));
  const archive = tarGz([
    tarEntry('repo-abc123/', '', '5'),
    tarEntry('repo-abc123/rtl/top.v', 'module top;\nendmodule\n'),
    tarEntry('repo-abc123/rtl/sub/leaf.v', 'module leaf;\nendmodule\n'),
    tarEntry('repo-abc123/README.md', 'hi'),
  ]);
  const files = extractTarGz(archive, tmp);
  assert.equal(files, 3);
  assert.ok(fs.existsSync(path.join(tmp, 'rtl', 'top.v')));
  assert.ok(fs.existsSync(path.join(tmp, 'rtl', 'sub', 'leaf.v')));
  assert.equal(fs.readFileSync(path.join(tmp, 'README.md'), 'utf8'), 'hi');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('extractTarGz skips pax headers and honors GNU long names', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-tar-'));
  const long = 'a'.repeat(140) + '.v';
  const archive = tarGz([
    tarEntry('pax_global_header', 'some pax metadata', 'g'),
    tarEntry('repo-x/', '', '5'),
    tarEntry('././@LongLink', long, 'L'),
    tarEntry('repo-x/truncated-name.v', 'module long_one;\nendmodule\n'),
  ]);
  extractTarGz(archive, tmp);
  assert.ok(fs.existsSync(path.join(tmp, long)), 'long name applied to next entry');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('extractTarGz rejects path traversal members', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-tar-'));
  const evil = tarGz([tarEntry('repo/../../evil.v', 'x')]);
  assert.throws(() => extractTarGz(evil, tmp), /escapes extraction root/);
  assert.ok(!fs.existsSync(path.resolve(tmp, '..', '..', 'evil.v')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('githubBlobUrl pins sha and line anchor', () => {
  const url = githubBlobUrl({ slug: 'olofk/serv', sha: 'deadbeef'.repeat(5) }, 'rtl/serv_top.v', 42);
  assert.equal(url, 'https://github.com/olofk/serv/blob/deadbeefdeadbeefdeadbeefdeadbeefdeadbeef/rtl/serv_top.v#L42');
});

test('github meta rewires wiki + svg + html evidence links (no network)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-ghlinks-'));
  const specFile = path.join(tmp, 's.topology.json');
  run(['derive', fixture, '--out', specFile, '--json']);
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  const sha = 'abc123def456abc123def456abc123def456abc1';
  spec.meta.project.github = { slug: 'acme/hsb', ref: 'main', sha };
  fs.writeFileSync(specFile, JSON.stringify(spec));
  const receipt = JSON.parse(run(['deliver', specFile, '--json']));
  assert.equal(receipt.ok, true);

  const wiki = fs.readFileSync(path.join(tmp, 's.wiki.md'), 'utf8');
  assert.match(wiki, new RegExp(`https://github\\.com/acme/hsb/blob/${sha}/hsb_top\\.v#L6`));
  assert.match(wiki, /acme\/hsb@abc123def4/);

  const svg = fs.readFileSync(path.join(tmp, 's.svg'), 'utf8');
  assert.ok(svg.includes(`<a class="node-link" href="https://github.com/acme/hsb/blob/${sha}/hsb_top.v#L6"`), 'svg nodes are permalinks');

  const html = fs.readFileSync(path.join(tmp, 's.html'), 'utf8');
  assert.ok(html.includes(`blob/${sha}/hsb_top.v#L6`), 'viewer index carries github urls');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('local projects keep relative links (no github meta)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hwtopo-locallinks-'));
  const specFile = path.join(tmp, 's.topology.json');
  run(['derive', fixture, '--out', specFile, '--json']);
  run(['deliver', specFile, '--json']);
  const wiki = fs.readFileSync(path.join(tmp, 's.wiki.md'), 'utf8');
  assert.match(wiki, /\]\(hsb_top\.v\)/);
  assert.ok(!wiki.includes('github.com/acme'));
  fs.rmSync(tmp, { recursive: true, force: true });
});
