// SETUP.md must embed every source file, byte for byte, so it stays a self-contained runbook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, embeddedFiles } from '../tools/build-setup-doc.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listFiles(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(path.join(dir, e.name)) : [path.join(dir, e.name).split(path.sep).join('/')]);
}

test('SETUP.md is up to date with the code', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'SETUP.md'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(build(doc), doc, 'run: npm run docs');
});

test('SETUP.md embeds every source file', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'SETUP.md'), 'utf8');
  const embedded = new Set(embeddedFiles(doc));
  const expected = [
    'README.md', 'package.json', '.gitignore', '.gitattributes',
    ...['bin', 'src', 'test', 'tools', 'e2e'].flatMap(listFiles),
  ];
  const missing = expected.filter((f) => !embedded.has(f));
  assert.deepEqual(missing, [], `add markers to SETUP.md for: ${missing.join(', ')}`);
});
