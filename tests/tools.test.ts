import { describe, expect, it } from 'vitest';
import { flagBool, flagInt, flagSeed, flagString, parseArgs, UsageError } from '../tools/args.ts';
import { getPolicy, policyNames } from '../tools/policies/index.ts';

describe('tools/args', () => {
  it('parses --key value, --key=value, bare flags and positionals', () => {
    // A bare flag followed by a bare token takes it as its value, so positionals go before flags.
    const a = parseArgs(['file.json', '--seed', '7', '--policy=random', '--events', '--x']);
    expect(a.flags).toEqual({ seed: '7', policy: 'random', events: true, x: true });
    expect(a.positional).toEqual(['file.json']);
    expect(flagString(a, 'policy', 'z')).toBe('random');
    expect(flagString(a, 'missing', 'z')).toBe('z');
    expect(flagBool(a, 'events')).toBe(true);
    expect(flagBool(a, 'nope')).toBe(false);
  });
  it('flagInt is strict about integers and ranges', () => {
    expect(flagInt(parseArgs(['--n', '12']), 'n', 0)).toBe(12);
    expect(flagInt(parseArgs(['--n', '-3']), 'n', 0)).toBe(-3);
    expect(flagInt(parseArgs([]), 'n', 5)).toBe(5);
    expect(() => flagInt(parseArgs(['--n', '1.5']), 'n', 0)).toThrow(UsageError);
    expect(() => flagInt(parseArgs(['--n', 'abc']), 'n', 0)).toThrow(UsageError);
    expect(() => flagInt(parseArgs(['--n']), 'n', 0)).toThrow(UsageError);
    expect(() => flagInt(parseArgs(['--n', '0']), 'n', 1, { min: 1 })).toThrow(/>= 1/);
    expect(() => flagInt(parseArgs(['--n', '99']), 'n', 1, { max: 10 })).toThrow(/<= 10/);
  });
  it('flagSeed enforces the 32-bit seed range', () => {
    expect(flagSeed(parseArgs(['--seed', '0']), 'seed', 1)).toBe(0);
    expect(flagSeed(parseArgs(['--seed', '4294967295']), 'seed', 1)).toBe(4294967295);
    expect(() => flagSeed(parseArgs(['--seed', '-1']), 'seed', 1)).toThrow(UsageError);
    expect(() => flagSeed(parseArgs(['--seed', '4294967296']), 'seed', 1)).toThrow(UsageError);
    expect(() => flagSeed(parseArgs(['--seed', '1.5']), 'seed', 1)).toThrow(UsageError);
  });
  it('unknown policies are a usage error', () => {
    expect(policyNames()).toContain('random');
    expect(() => getPolicy('nope')).toThrow(UsageError);
  });
});
