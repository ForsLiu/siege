// The sandbox controller: an editable SandboxSetup, single-fight playback and headless batch
// runs, with no DOM. Mirrors runController.ts's shape but never touches RunState (P0-17/P0-18).
// Save/load go through the dev data endpoint, which does not exist outside a dev build; the
// controller never imports it directly (that would leak `writeDataFile`/`readDataFile` into the
// production bundle, see tests/slow/build.test.ts) and instead takes it as an injected
// `SandboxPersistence`, wired up by main.ts only inside its existing DEV-guarded dynamic import.
import { fight, type FightResult } from '../sim/fight.ts';
import type { Cell } from '../sim/hex.ts';
import { canAddItem, combineOrAppend } from '../sim/items.ts';
import type { Content } from '../sim/rules.ts';
import { buildSandboxFight, runSandbox, type SandboxResult, type SandboxRuleOverrides, type SandboxSetup, type SandboxSide, type SandboxUnit } from '../sim/sandbox.ts';
import type { StatBlock, StatName } from '../sim/stats.ts';
import type { UnitDef } from '../sim/units.ts';
import { advancePlayback, startPlayback, type PlaybackState } from './playback.ts';
import type { ScreenEvent } from './screens.ts';

export interface SandboxPersistenceResult {
  ok: boolean;
  error: string | null;
}

export interface SandboxLoadResult extends SandboxPersistenceResult {
  setup: SandboxSetup | null;
}

export interface SandboxPersistence {
  save(name: string, setup: SandboxSetup): Promise<SandboxPersistenceResult>;
  load(name: string): Promise<SandboxLoadResult>;
}

export interface SandboxControllerDeps {
  content: Content;
  onScreenEvent(ev: ScreenEvent): void;
  onChange(): void;
}

// Matches kindForPath's sandboxSetupFile pattern (src/data/manifest.ts) exactly, including the
// length cap: an unbounded name reached the filesystem's name limit and crashed the dev server
// before that endpoint's write got its own try/catch (QA on P0-18).
const SETUP_NAME_RE = /^[a-z0-9_-]{1,64}$/;

function emptySetup(): SandboxSetup {
  return { left: [], right: [], rules: {} };
}

export class SandboxController {
  setup: SandboxSetup = emptySetup();
  seed = 1;
  n = 50;
  lastResult: FightResult | null = null;
  lastAggregate: SandboxResult | null = null;
  message = '';
  /** Row selected for the P0-20 inspector; outside sim state, like RunController.selectedUid. */
  selected: { side: SandboxSide; index: number } | null = null;
  /** The synthetic per-instance unit defs behind `lastResult`, for the renderer's labels. */
  lastUnits: Record<string, UnitDef> | null = null;
  private play: PlaybackState | null = null;
  private persistence: SandboxPersistence | null = null;
  private readonly deps: SandboxControllerDeps;
  private readonly tickRate: number;
  private readonly moveTicks: number;

  constructor(deps: SandboxControllerDeps) {
    this.deps = deps;
    this.tickRate = deps.content.rules.tickRate;
    this.moveTicks = Math.max(1, Math.round(deps.content.rules.combat.moveSecondsPerHex * this.tickRate));
  }

  get playback(): PlaybackState | null {
    return this.play;
  }

  /** Wired up by main.ts once the dev module resolves; absent in a production build. */
  setPersistence(p: SandboxPersistence | null): void {
    this.persistence = p;
  }

  enter(): void {
    this.setup = emptySetup();
    this.seed = 1;
    this.lastResult = null;
    this.lastUnits = null;
    this.lastAggregate = null;
    this.message = '';
    this.play = null;
    this.selected = null;
    this.deps.onScreenEvent({ type: 'enterSandbox' });
    this.deps.onChange();
  }

  /** Drops any playback and forgets the setup (leaving the sandbox screen). */
  clear(): void {
    this.play = null;
  }

  /** Toggles the P0-20 inspector selection off when the same row is clicked again. */
  selectUnit(side: SandboxSide, index: number): void {
    const sel = this.selected;
    this.selected = sel !== null && sel.side === side && sel.index === index ? null : { side, index };
    this.deps.onChange();
  }

  clearSelection(): void {
    if (this.selected === null) return;
    this.selected = null;
    this.deps.onChange();
  }

  addUnit(side: SandboxSide, defId: string): void {
    if (!this.deps.content.unitsById[defId]) return;
    const cell = this.freeCell(side);
    if (!cell) {
      this.message = `${side} side is full`;
      this.deps.onChange();
      return;
    }
    const unit: SandboxUnit = { defId, star: 1, col: cell.col, row: cell.row, items: [], statOverrides: {} };
    this.setup = { ...this.setup, [side]: [...this.setup[side], unit] };
    this.deps.onChange();
  }

  removeUnit(side: SandboxSide, index: number): void {
    this.setup = { ...this.setup, [side]: this.setup[side].filter((_, i) => i !== index) };
    const sel = this.selected;
    if (sel !== null && sel.side === side) {
      if (sel.index === index) this.selected = null;
      else if (sel.index > index) this.selected = { side, index: sel.index - 1 };
    }
    this.deps.onChange();
  }

  setStar(side: SandboxSide, index: number, star: number): void {
    this.patchUnit(side, index, { star });
  }

  setItems(side: SandboxSide, index: number, items: string[]): void {
    this.patchUnit(side, index, { items });
  }

  /**
   * Drop `itemId` onto a sandbox unit (P0-29): the sandbox has no item bench or Command log, so
   * this mirrors `equipItem`'s combine-or-append rule and its item-slot cap directly over the
   * unit's own `items` array, rather than going through a Command.
   */
  dragItemOntoUnit(side: SandboxSide, index: number, itemId: string): { ok: boolean; reason: string | null } {
    if (this.play) return { ok: false, reason: 'cannot equip items during playback' };
    const unit = this.setup[side][index];
    if (!unit) return { ok: false, reason: `no unit at ${side}[${index}]` };
    const { itemsById, recipesByKey } = this.deps.content;
    if (!Object.hasOwn(itemsById, itemId)) return { ok: false, reason: `unknown item id ${itemId}` };
    const cap = this.deps.content.rules.economy.itemSlots;
    const reason = canAddItem(unit.items, itemId, itemsById, recipesByKey, cap);
    if (reason) return { ok: false, reason };
    this.setItems(side, index, combineOrAppend(unit.items, itemId, itemsById, recipesByKey));
    return { ok: true, reason: null };
  }

  setStatOverride(side: SandboxSide, index: number, stat: StatName, value: number | null): void {
    const list = this.setup[side];
    const u = list[index];
    if (!u) return;
    const overrides: Partial<StatBlock> = { ...u.statOverrides };
    if (value === null) delete overrides[stat];
    else overrides[stat] = value;
    this.patchUnit(side, index, { statOverrides: overrides });
  }

  setRules(patch: SandboxRuleOverrides): void {
    this.setup = { ...this.setup, rules: { ...this.setup.rules, ...patch } };
    this.deps.onChange();
  }

  setSeed(seed: number): void {
    this.seed = seed;
  }

  setN(n: number): void {
    this.n = n;
  }

  private patchUnit(side: SandboxSide, index: number, patch: Partial<SandboxUnit>): void {
    this.setup = { ...this.setup, [side]: this.setup[side].map((u, i) => (i === index ? { ...u, ...patch } : u)) };
    this.deps.onChange();
  }

  private freeCell(side: SandboxSide): Cell | null {
    const board = this.deps.content.board;
    const occupied = new Set(this.setup[side].map((u) => `${u.col},${u.row}`));
    for (let row = board.rows - board.playerRows; row < board.rows; row++) {
      for (let col = 0; col < board.cols; col++) {
        if (!occupied.has(`${col},${row}`)) return { col, row };
      }
    }
    return null;
  }

  runOnce(): void {
    if (this.setup.left.length === 0 && this.setup.right.length === 0) {
      this.message = 'add at least one unit to either side';
      this.deps.onChange();
      return;
    }
    const { left, right, rules } = buildSandboxFight(this.deps.content, this.setup);
    const result = fight(left, right, this.seed, rules);
    this.lastResult = result;
    this.lastUnits = rules.units;
    this.lastAggregate = null;
    this.startPlayback(result);
  }

  /** Replays the last computed fight (same seed): restarts the timeline, no new fight() call. */
  replay(): void {
    if (!this.lastResult) return;
    this.startPlayback(this.lastResult);
  }

  runN(): void {
    if (this.setup.left.length === 0 && this.setup.right.length === 0) {
      this.message = 'add at least one unit to either side';
      this.deps.onChange();
      return;
    }
    this.lastAggregate = runSandbox(this.deps.content, this.setup, this.seed, this.n);
    this.lastResult = null;
    this.lastUnits = null;
    this.play = null;
    this.message = '';
    this.deps.onChange();
  }

  async save(name: string): Promise<void> {
    if (!SETUP_NAME_RE.test(name)) {
      this.message = 'name must be 1-64 lowercase letters, digits, "-" or "_"';
      this.deps.onChange();
      return;
    }
    if (!this.persistence) {
      this.message = 'save is unavailable outside a dev build';
      this.deps.onChange();
      return;
    }
    const res = await this.persistence.save(name, this.setup);
    this.message = res.ok ? `saved sandbox-${name}.json` : (res.error ?? 'save failed');
    this.deps.onChange();
  }

  async load(name: string): Promise<void> {
    if (!SETUP_NAME_RE.test(name)) {
      this.message = 'name must be 1-64 lowercase letters, digits, "-" or "_"';
      this.deps.onChange();
      return;
    }
    if (!this.persistence) {
      this.message = 'load is unavailable outside a dev build';
      this.deps.onChange();
      return;
    }
    const res = await this.persistence.load(name);
    if (res.ok && res.setup) {
      this.setup = res.setup;
      this.lastResult = null;
      this.lastUnits = null;
      this.lastAggregate = null;
      this.play = null;
    }
    this.message = res.ok ? `loaded sandbox-${name}.json` : (res.error ?? 'load failed');
    this.deps.onChange();
  }

  /** Advances playback by `dt` seconds at `speed`; a no-op once it has run past the last tick. */
  advance(dt: number, speed: number): void {
    const p = this.play;
    if (!p) return;
    const next = advancePlayback(p, dt, speed, this.tickRate);
    if (next === p) return;
    this.play = next;
    if (next === null) {
      p.onDone?.();
      this.deps.onChange();
    }
  }

  private startPlayback(result: FightResult): void {
    const pending = this.play;
    this.play = null;
    pending?.onDone?.();
    this.message = '';
    this.play = startPlayback(result, this.moveTicks, () => {
      this.message = summaryLine(result, this.tickRate);
      this.deps.onChange();
    });
    this.deps.onChange();
  }
}

function summaryLine(f: FightResult, tickRate: number): string {
  const verdict = f.winner === 'left' ? 'Left wins' : f.winner === 'right' ? 'Right wins' : 'Draw';
  return `${verdict} (${f.reason}) in ${(f.ticks / tickRate).toFixed(1)}s`;
}
