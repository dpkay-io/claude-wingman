// Embed the repo's files verbatim into SETUP.md between file markers, so the runbook is self-contained.
//   node tools/build-setup-doc.js           rewrite SETUP.md
//   node tools/build-setup-doc.js --check   exit 1 if SETUP.md is out of date
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(ROOT, 'SETUP.md');
// Built from pieces so this file, which is itself embedded in SETUP.md, never contains a literal marker.
const OPEN = '<!-- ' + 'BEGIN FILE: ';
const CLOSE = '<!-- ' + 'END FILE -->';
const BLOCK = new RegExp(`(${OPEN}(\\S+) -->\\n)[\\s\\S]*?(${CLOSE})`, 'g');
const LANG = { '.js': 'js', '.json': 'json', '.md': 'markdown' };

function fenced(rel) {
  let text = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  if (!text.endsWith('\n')) text += '\n';
  // Four backticks, so files containing ``` fences (README) stay intact.
  return `**\`${rel}\`**\n\n\`\`\`\`${LANG[path.extname(rel)] ?? ''}\n${text}\`\`\`\`\n`;
}

export const build = (doc) => doc.replace(BLOCK, (_, open, rel, close) => open + fenced(rel) + close);
export const embeddedFiles = (doc) => [...doc.matchAll(BLOCK)].map((m) => m[2]);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const current = fs.readFileSync(DOC, 'utf8');
  const updated = build(current);
  if (process.argv.includes('--check')) {
    if (updated !== current) {
      console.error('SETUP.md is out of date; run: node tools/build-setup-doc.js');
      process.exit(1);
    }
    console.log('SETUP.md is up to date');
  } else {
    fs.writeFileSync(DOC, updated);
    console.log(`embedded ${embeddedFiles(updated).length} files into SETUP.md`);
  }
}
