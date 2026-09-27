/**
 * Minimal flag parser shared by the context-guard CLIs, plus the one output
 * formatter both the CLI and the hook need.
 *
 * Exists so the two entry points cannot drift from their documented flags:
 * every accepted flag is declared here, an unknown flag is a hard error, and
 * `--help` always prints the same declaration it parses.
 */

export class UsageError extends Error {
  constructor(message, usage) {
    super(message);
    this.name = 'UsageError';
    this.usage = usage;
  }
}

const camel = (raw) => raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

/**
 * Parse `--flag value` / `--flag=value` / boolean `--flag` against a spec.
 * @param {string[]} argv process.argv.slice(2)
 * @param {{values?: string[], bools?: string[], usage: string}} spec
 * @returns {{args: Record<string, string|boolean>, positionals: string[]}}
 * @throws {UsageError} for an unknown flag, a missing value, or an unexpected positional.
 */
export function parseFlags(argv, spec) {
  const values = new Set(spec.values ?? []);
  const bools = new Set(spec.bools ?? []);
  const args = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const [rawKey, inline] = token.slice(2).split('=');
    const key = camel(rawKey);
    if (key === 'help') {
      args.help = true;
      continue;
    }
    if (values.has(key)) {
      const value = inline !== undefined ? inline : argv[++i];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`参数 --${rawKey} 缺少取值`, spec.usage);
      }
      args[key] = value;
      continue;
    }
    if (bools.has(key)) {
      args[key] = inline === undefined ? true : inline !== 'false' && inline !== '0';
      continue;
    }
    throw new UsageError(`未知参数 --${rawKey}`, spec.usage);
  }
  if (positionals.length > 0) {
    throw new UsageError(`不接受的裸参数: ${positionals.join(' ')}`, spec.usage);
  }
  return { args, positionals };
}

/** Compact token count for terminal output (one home for both callers). */
export function fmtTokens(value) {
  if (!Number.isFinite(value)) return 'n/a';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 2)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(Math.round(value));
}
