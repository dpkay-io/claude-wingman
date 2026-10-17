// Interactive questions, with safe defaults when there is no terminal (e.g. inside an agent).
import readline from 'node:readline/promises';
import { CliError } from './util.js';

// CLAUDE_WINGMAN_NONINTERACTIVE is set for commands run on another machine through a remote terminal (a TTY).
export const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CLAUDE_WINGMAN_NONINTERACTIVE);

/** Ask a question; returns `def` when the answer is empty or there's no terminal. Re-asks while `validate` throws. */
export async function ask(question, def, validate = (v) => v) {
  if (!interactive()) return validate(def);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question(`${question} [${def}]: `)).trim() || def;
      try {
        return validate(answer);
      } catch (err) {
        if (!(err instanceof CliError)) throw err;
        console.log(`  ${err.message}${err.hint ? ` ${err.hint}` : ''}`);
      }
    }
  } finally {
    rl.close();
  }
}

/** Parse "all", "2" or "1,3" (spaces also work) into 0-based indexes of `count` items. */
export function parseSelection(answer, count) {
  const text = String(answer).trim().toLowerCase();
  if (text === 'all' || text === 'a') return [...Array(count).keys()];
  const picks = text.split(/[\s,]+/).filter(Boolean).map(Number);
  if (!picks.length || picks.some((n) => !Number.isInteger(n) || n < 1 || n > count)) {
    throw new CliError(`Enter "all", or numbers from 1 to ${count} separated by commas.`);
  }
  return [...new Set(picks)].map((n) => n - 1);
}

/** Pick some of `items` (default: all). Throws (with the list) when there's no terminal. */
export async function chooseMany(question, items, label, { hint } = {}) {
  if (!interactive()) {
    throw new CliError(`Several machines are online: ${items.map(label).join(', ')}.`, { hint });
  }
  items.forEach((item, i) => console.log(`  ${i + 1}) ${label(item)}`));
  const picks = await ask(`${question} Numbers like 1,3, or "all"`, 'all', (v) => parseSelection(v, items.length));
  return picks.map((i) => items[i]);
}
