// Tiny CLI argument parser: --key value, --key=value, --flag, positional.
export interface Args {
  flags: Record<string, string | true>;
  positional: string[];
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export function parseArgs(argv: readonly string[]): Args {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[a.slice(2)] = next;
        i++;
      } else {
        flags[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

export function flagString(args: Args, name: string, fallback: string): string {
  const v = args.flags[name];
  return typeof v === 'string' ? v : fallback;
}

/** Strict integer flag: "1.5", "abc" and a bare --flag are usage errors. */
export function flagInt(args: Args, name: string, fallback: number, opts: { min?: number; max?: number } = {}): number {
  const v = args.flags[name];
  if (v === undefined) return fallback;
  if (v === true || !/^-?\d+$/.test(v)) throw new UsageError(`--${name} must be an integer, got ${String(v)}`);
  const n = Number.parseInt(v, 10);
  if (opts.min !== undefined && n < opts.min) throw new UsageError(`--${name} must be >= ${opts.min}, got ${n}`);
  if (opts.max !== undefined && n > opts.max) throw new UsageError(`--${name} must be <= ${opts.max}, got ${n}`);
  return n;
}

export const SEED_MAX = 0xffffffff;

/** Run/fight seed: integer in [0, 2^32). */
export function flagSeed(args: Args, name: string, fallback: number): number {
  return flagInt(args, name, fallback, { min: 0, max: SEED_MAX });
}

export function flagBool(args: Args, name: string): boolean {
  return args.flags[name] !== undefined;
}

/** Run a tool body; usage and content errors print one line and exit 1 (no stack trace). */
export function runTool(body: () => void | Promise<void>): void {
  Promise.resolve()
    .then(body)
    .catch((e: unknown) => {
      if (e instanceof Error && (e.name === 'UsageError' || e.name === 'ContentError')) {
        console.error(`error: ${e.message}`);
      } else {
        console.error(e);
      }
      process.exitCode = 1;
    });
}
