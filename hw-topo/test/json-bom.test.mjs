// UTF-8 BOM tolerance at the JSON boundary.
//
// Why this deserves its own test file: on Windows the most likely way a human
// (or an agent driving PowerShell) produces a spec is
// `Get-Content ... | Set-Content -Encoding UTF8`, which writes a BOM. Notepad's
// "UTF-8 with BOM" does the same. `JSON.parse` then fails with
// "Unexpected token '<invisible>'" — which reads as "my file is corrupt" and
// hides the real, trivial cause. This was observed during acceptance, not
// theorised, so it gets a permanent guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseJson } from '../lib/util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'examples', 'fixture', 'rtl');
const cli = path.resolve(here, '..', 'bin', 'hw-topo.mjs');
const BOM = '\uFEFF';

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function tmpFile(name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-topo-bom-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

test('parseJson: a leading BOM is stripped, not rejected', () => {
  assert.deepEqual(parseJson(`${BOM}{"a":1}`), { a: 1 });
  assert.deepEqual(parseJson(`${BOM}  {"a":1}`), { a: 1 });
  assert.deepEqual(parseJson(`${BOM}[1,2]`), [1, 2]);
});

test('parseJson: BOM-free input is untouched (no accidental behaviour change)', () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJson('\n{"a":1}'), { a: 1 });
  // A BOM is only legal at the very start; one in the middle must still fail.
  assert.throws(() => parseJson('{"a":\uFEFF1}'), SyntaxError);
});

test('parseJson: genuinely malformed JSON still throws (the guard is not a silencer)', () => {
  assert.throws(() => parseJson(`${BOM}{"a":`), SyntaxError);
  assert.throws(() => parseJson(`${BOM}not json`), SyntaxError);
  assert.throws(() => parseJson(`${BOM}{"a":1,}`), SyntaxError);
});

test('cli: a BOM-prefixed spec is accepted (builtin backend, hermetic)', () => {
  const bundle = tmpFile('bundle.json', '');
  const spec = tmpFile('spec.json', '');
  const scanned = runCli(['scan', fixture, '--backend', 'builtin', '--out', bundle, '--json']);
  assert.equal(scanned.status, 0, scanned.stderr);
  const derived = runCli(['derive', bundle, '--out', spec, '--json']);
  assert.equal(derived.status, 0, derived.stderr);

  const body = fs.readFileSync(spec, 'utf8');
  const bombSpec = tmpFile('spec-bom.json', BOM + body);
  // Sanity: the file really does start with a BOM byte sequence.
  assert.deepEqual([...fs.readFileSync(bombSpec).subarray(0, 3)], [0xef, 0xbb, 0xbf]);

  const validated = runCli(['validate', bombSpec, '--json']);
  assert.equal(validated.status, 0, `BOM spec must validate; stderr=${validated.stderr}`);

  // And the same spec WITHOUT the BOM behaves identically — the fix must not
  // make BOM-prefixed input a different code path in any observable way.
  const plainSpec = tmpFile('spec-plain.json', body);
  const validatedPlain = runCli(['validate', plainSpec, '--json']);
  assert.equal(validatedPlain.status, validated.status);
  assert.equal(validatedPlain.stdout, validated.stdout);
});

test('cli: a BOM-prefixed bundle is accepted by derive', () => {
  const bundle = tmpFile('bundle.json', '');
  const spec = tmpFile('spec.json', '');
  assert.equal(runCli(['scan', fixture, '--backend', 'builtin', '--out', bundle, '--json']).status, 0);
  const bombBundle = tmpFile('bundle-bom.json', BOM + fs.readFileSync(bundle, 'utf8'));
  const derived = runCli(['derive', bombBundle, '--out', spec, '--json']);
  assert.equal(derived.status, 0, derived.stderr);
});

test('cli: a BOM does not turn malformed input into accepted input', () => {
  const broken = tmpFile('broken.json', `${BOM}{"nodes": [`);
  const result = runCli(['validate', broken, '--json']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot read/);
});
