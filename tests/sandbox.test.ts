import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSandboxSetupFromDisk, readJson } from '../src/data/node.ts';
import { loadSandboxSetupFile } from '../src/data/loader.ts';
import { fight, type FightResult } from '../src/sim/fight.ts';
import { buildSandboxFight, runSandbox, type SandboxSetup } from '../src/sim/sandbox.ts';
import { devContent } from './helpers.ts';

const FIXTURE = 'data/dev/boards/sandbox-fixture.json';

describe('sandbox core (P0-17)', () => {
  const content = devContent();

  it('runSandbox aggregation equals a direct loop of fight() over the same seeds', () => {
    const setup = loadSandboxSetupFromDisk(FIXTURE, content);
    const seed = 7;
    const n = 5;
    const result = runSandbox(content, setup, seed, n);

    const { left, right, rules, owners } = buildSandboxFight(content, setup);
    let leftWins = 0;
    let rightWins = 0;
    let draws = 0;
    const ticks: number[] = [];
    const totals = new Map<string, { dealt: number; taken: number; healed: number; deaths: number }>();
    for (const id of owners.keys()) totals.set(id, { dealt: 0, taken: 0, healed: 0, deaths: 0 });
    for (let i = 0; i < n; i++) {
      const r: FightResult = fight(left, right, seed + i, rules);
      ticks.push(r.ticks);
      if (r.winner === 'left') leftWins++;
      else if (r.winner === 'right') rightWins++;
      else draws++;
      for (const e of r.ledger) {
        const t = totals.get(e.defId);
        if (!t) continue;
        t.dealt += e.dealt;
        t.taken += e.taken;
        t.healed += e.healed;
        t.deaths += e.deaths;
      }
    }
    const mean = ticks.reduce((s, v) => s + v, 0) / n;

    expect(result.fights).toBe(n);
    expect(result.wins).toEqual({ left: leftWins, right: rightWins, draw: draws });
    expect(result.winRate).toEqual({ left: leftWins / n, right: rightWins / n, draw: draws / n });
    expect(result.meanTicks).toBeCloseTo(mean, 9);
    for (const agg of result.units) {
      const id = `sandbox:${agg.side}:${agg.index}`;
      const t = totals.get(id);
      expect(t).toBeDefined();
      expect(agg.dealt).toBeCloseTo(t!.dealt, 9);
      expect(agg.taken).toBeCloseTo(t!.taken, 9);
      expect(agg.healed).toBeCloseTo(t!.healed, 9);
      expect(agg.deaths).toBe(t!.deaths);
    }
  });

  it('a stat override actually changes the fight (overridden brawler out-damages the base unit)', () => {
    const setup = loadSandboxSetupFromDisk(FIXTURE, content);
    const overridden = runSandbox(content, setup, 1, 3);
    const plainSetup: SandboxSetup = { ...setup, left: setup.left.map((u) => ({ ...u, statOverrides: {} })) };
    const plain = runSandbox(content, plainSetup, 1, 3);
    const brawlerOverridden = overridden.units.find((u) => u.side === 'left' && u.index === 0)!;
    const brawlerPlain = plain.units.find((u) => u.side === 'left' && u.index === 0)!;
    expect(brawlerOverridden.dealt).toBeGreaterThan(brawlerPlain.dealt);
  });

  it('save -> load of a setup round-trips identically', () => {
    const original = loadSandboxSetupFromDisk(FIXTURE, content);
    const dir = mkdtempSync(join(tmpdir(), 'siege-sandbox-'));
    const path = join(dir, 'sandbox-roundtrip.json');
    writeFileSync(path, JSON.stringify(original, null, 2), 'utf8');
    const reloaded = loadSandboxSetupFile(path, readJson(path), content);
    expect(reloaded).toEqual(original);
    // The raw fixture on disk (pre-defaults) parses to the same setup too.
    const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
    expect(loadSandboxSetupFile(FIXTURE, raw, content)).toEqual(original);
  });

  it('rejects an unknown unit id and a cell used twice, like a fight board', () => {
    expect(() => loadSandboxSetupFile('t.json', { left: [{ defId: 'nope', star: 1, col: 0, row: 4 }], right: [], rules: {} }, content)).toThrow(/unknown unit/);
    expect(() =>
      loadSandboxSetupFile(
        't.json',
        {
          left: [
            { defId: 'dev.brawler', star: 1, col: 0, row: 4 },
            { defId: 'dev.archer', star: 1, col: 0, row: 4 },
          ],
          right: [],
          rules: {},
        },
        content,
      ),
    ).toThrow(/used twice/);
  });

  it('runSandbox rejects a non-positive fight count', () => {
    const setup = loadSandboxSetupFromDisk(FIXTURE, content);
    expect(() => runSandbox(content, setup, 1, 0)).toThrow(/positive integer/);
  });

  it('never reads or writes RunState: no reference to it anywhere in the module code', () => {
    const src = readFileSync('src/sim/sandbox.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src.includes('RunState')).toBe(false);
    expect(/from\s+['"]\.\/run\.ts['"]/.test(src)).toBe(false);
  });
});
