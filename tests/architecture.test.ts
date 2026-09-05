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

/**
 * Constructor parameter properties, detected by walking the parameter list with balanced
 * brackets: a plain regex either misses `constructor(fn: () => void, private readonly n: number)`
 * or false-positives on `constructor(opts: { readonly count: number })`.
 */
export function hasParameterProperty(src: string): boolean {
  const open = /constructor\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(src)) !== null) {
    let depth = 1;
    let param = '';
    const params: string[] = [];
    for (let i = open.lastIndex; i < src.length && depth > 0; i++) {
      const ch = src[i] as string;
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) break;
      }
      if (depth === 1 && ch === ',') {
        params.push(param);
        param = '';
      } else {
        param += ch;
      }
    }
    params.push(param);
    if (params.some((p) => /^\s*(?:public|private|protected|readonly)\b/.test(p))) return true;
  }
  return false;
}

describe('architecture: erasable-syntax scanner', () => {
  // The scanner is the fast-tier guard for P0-B1, so it gets its own fixtures.
  const cases: { src: string; flag: boolean; why: string }[] = [
    { src: 'class A { constructor(private readonly n: number) {} }', flag: true, why: 'plain parameter property' },
    { src: 'class A { constructor(fn: () => void, private readonly n: number) {} }', flag: true, why: 'after a function-typed parameter' },
    { src: 'class A { constructor(\n  public readonly file: string,\n  message: string,\n) {} }', flag: true, why: 'multi-line' },
    { src: 'class A { constructor(opts: { readonly count: number }) {} }', flag: false, why: 'readonly inside an object type' },
    { src: 'class A { private readonly n: number; constructor(n: number) { this.n = n; } }', flag: false, why: 'plain field plus assignment' },
    { src: 'class A { constructor(a: number, b: Map<string, () => void>) {} }', flag: false, why: 'generics and callbacks' },
  ];
  for (const c of cases) {
    it(`${c.flag ? 'flags' : 'accepts'} ${c.why}`, () => {
      expect(hasParameterProperty(c.src)).toBe(c.flag);
    });
  }
});

describe('architecture: every module stays erasable TypeScript', () => {
  // The sweep spawns its worker with plain Node, which strips types without transforming them
  // (P0-B1). Constructor parameter properties, enums and namespaces are not erasable, so they
  // break any module the worker reaches. `erasableSyntaxOnly` in tsconfig catches this in
  // `npm run check`; this test puts the same guard in the fast tier, which is the per-item gate.
  const NON_ERASABLE: { name: string; test: (src: string) => boolean }[] = [
    { name: 'constructor parameter property', test: hasParameterProperty },
    { name: 'enum declaration', test: (src) => /(^|[^A-Za-z0-9_$.])(?:const\s+)?enum\s+[A-Za-z_$]/.test(src) },
    { name: 'namespace declaration', test: (src) => /(^|[^A-Za-z0-9_$.])namespace\s+[A-Za-z_$]/.test(src) },
    { name: 'import-equals', test: (src) => /(^|[^A-Za-z0-9_$.])import\s+[A-Za-z_$][\w$]*\s*=\s*require\s*\(/.test(src) },
  ];
  for (const dir of ['src', 'tools', 'tests']) {
    for (const file of walk(join(REPO_ROOT, dir))) {
      const rel = relative(REPO_ROOT, file);
      // This file names the forbidden syntax in its own patterns, so it cannot scan itself.
      if (rel.endsWith('architecture.test.ts')) continue;
      it(`${rel} uses only erasable syntax`, () => {
        const src = stripComments(readFileSync(file, 'utf8'));
        const found = NON_ERASABLE.filter((n) => n.test(src)).map((n) => n.name);
        expect(found, `non-erasable syntax in ${rel}`).toEqual([]);
      });
    }
  }
});
