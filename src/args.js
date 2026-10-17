// Minimal argument parser: --flag, --flag value, --flag=value, -- (end of options).
import { CliError } from './util.js';

/**
 * @param {string[]} argv
 * @param {Record<string, 'string'|'boolean'>} spec  allowed flags and their types
 * @returns {{ opts: Record<string, string|boolean>, positionals: string[] }}
 */
export function parseArgs(argv, spec = {}) {
  const opts = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const type = spec[name];
    if (!type) throw new CliError(`Unknown option --${name}.`, { hint: 'Run: claude-wingman help' });
    if (type === 'boolean') {
      if (eq !== -1) throw new CliError(`--${name} doesn't take a value.`);
      opts[name] = true;
    } else {
      const value = eq !== -1 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined || value === '') throw new CliError(`--${name} needs a value.`);
      opts[name] = value;
    }
  }
  return { opts, positionals };
}
