// Production build contains neither the dev data endpoint nor the dev tools — including when the
// build runs under NODE_ENV=test (vitest's default), which is why the client gate is the
// config-level __SIEGE_DEV__ define and not import.meta.env.DEV.
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../src/data/node.ts';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// `devCommands:!0` / `devCommands:true` would mean a production bundle creating runs that
// accept the `dev:` cheat namespace (P0-15); the minifier folds the DEV branch to `!1`.
const FORBIDDEN = ['__data/', 'dev-overlay', 'siege-dev-data', 'writeDataFile', 'readDataFile', 'DATA_ENDPOINT', 'dev/index', 'createOverlay', 'dev tools unavailable', '__SIEGE_DEV__', 'devCommands:!0', 'devCommands: !0', 'devCommands:true', 'devCommands: true'];

function buildAndScan(nodeEnv: string | undefined): { files: string[]; hits: string[] } {
  const env = { ...process.env };
  if (nodeEnv === undefined) delete env['NODE_ENV'];
  else env['NODE_ENV'] = nodeEnv;
  execSync('npx vite build --logLevel error', { cwd: REPO_ROOT, stdio: 'pipe', env });
  const dist = join(REPO_ROOT, 'dist');
  expect(existsSync(dist)).toBe(true);
  const files = walk(dist).filter((f) => /\.(js|html|css)$/.test(f));
  const hits: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const token of FORBIDDEN) if (src.includes(token)) hits.push(`${f}: ${token}`);
  }
  return { files, hits };
}

describe('production build', () => {
  it('built with NODE_ENV=production contains no dev endpoint, overlay or dev client code', () => {
    const { files, hits } = buildAndScan('production');
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => /[\\/]dev-[^\\/]*\.js$/.test(f)), 'no dev chunk is emitted').toBe(false);
    expect(hits).toEqual([]);
  }, 120_000);

  it('built under NODE_ENV=test (as vitest would) still contains no dev code', () => {
    const { hits } = buildAndScan('test');
    expect(hits).toEqual([]);
    // Leave a real production build behind for `npm run preview`.
    buildAndScan('production');
  }, 120_000);
});
