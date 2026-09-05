// Architecture rules from CLAUDE.md, enforced: /src/sim is pure.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/data/node.ts';

const SIM_DIR = join(REPO_ROOT, 'src', 'sim');

const FORBIDDEN_TOKENS = [
  'Math.random',
  'Date.now',
  'performance.now',
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'document',
  'window',
  'Math.sin',
  'Math.cos',
  'Math.tan',
  'Math.atan',
  'Math.atan2',
  'Math.asin',
  'Math.acos',
  'Math.sinh',
  'Math.cosh',
  'Math.tanh',
  'Math.hypot',
  'localStorage',
  'fetch(',
  'localeCompare(',
  'new Date(',
  'crypto.',
  'Intl.',
  'process.',
];

const FORBIDDEN_IMPORTS = [/from\s+['"][^'"]*\/(render|ui|app|dev)\//, /from\s+['"][^'"]*\/(render|ui|app|dev)['"]/, /from\s+['"]node:/, /from\s+['"]vite/];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('architecture: /src/sim is pure', () => {
  const files = walk(SIM_DIR);

  it('has sim source files', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    it(`${rel} uses no forbidden tokens or imports`, () => {
      const src = stripComments(readFileSync(file, 'utf8'));
      const violations: string[] = [];
      for (const token of FORBIDDEN_TOKENS) {
        const re = new RegExp(`(^|[^A-Za-z0-9_$.])${token.replace(/[.(]/g, '\\$&')}`);
        if (re.test(src)) violations.push(token);
      }
      for (const re of FORBIDDEN_IMPORTS) if (re.test(src)) violations.push(`import ${re.source}`);
      expect(violations, `violations in ${rel}`).toEqual([]);
    });
  }
});

describe('architecture: no tuning numbers hidden in src/sim rules access', () => {
  it('sim never imports JSON data files directly', () => {
    for (const file of walk(SIM_DIR)) {
      const src = stripComments(readFileSync(file, 'utf8'));
      expect(/\.json['"]/.test(src), `${relative(REPO_ROOT, file)} imports JSON`).toBe(false);
    }
  });
});
