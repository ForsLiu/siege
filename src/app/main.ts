// App glue: content -> RunController -> renderer/UI, screen state machine, input mapping, loop.
// The sim is driven exclusively through Commands; rendering reads state and fight events.
// Everything testable lives next door: runController.ts (dispatch/playback/abandon),
// drag.ts (drop rules), hotkeys.ts (key mapping), screens.ts (screen machine).
import './style.css';
import { DEV_BOARD_NAMES, devBoardUnits, loadBrowserContent } from '../data/browser.ts';
import { BoardRenderer, type RangeRingView } from '../render/board.ts';
import type { UnitSnapshot } from '../render/timeline.ts';
import type { Command } from '../sim/commands.ts';
import { fight, type FightResult } from '../sim/fight.ts';
import type { Cell } from '../sim/hex.ts';
import { isPlayerCell, mirrorCell } from '../sim/hex.ts';
import { fightRulesFrom } from '../sim/rules.ts';
import { boardUnitAt, currentEncounter, shopTierCount, type RunState } from '../sim/run.ts';
import type { SandboxSide } from '../sim/sandbox.ts';
import { createPauseScreen, createResultsScreen, createTitleScreen } from '../ui/screens.ts';
import { createRunUi } from '../ui/runUi.ts';
import { createSandboxUi } from '../ui/sandboxUi.ts';
import { createInspectorUi } from '../ui/inspectorUi.ts';
import { canDrag, canDragItem, dropOutcome, itemDropOutcome, type DropOutcome } from './drag.ts';
import { hotkeyAction, isViewAction } from './hotkeys.ts';
import { inspectorModel, rangeRings, sandboxPreviewModel, shopPreviewModel, type InspectorModel } from './inspectorModel.ts';
import type { PlaybackState } from './playback.ts';
import { boardClick, boardDrop, type PointerOutcome } from './pointer.ts';
import { RunController } from './runController.ts';
import { SandboxController, type SandboxPersistence } from './sandboxController.ts';
import { initialScreen, reduceScreen, type ScreenEvent, type ScreenState } from './screens.ts';
import type { DevOverlay } from '../dev/overlay.ts';
import type { DevPanel } from '../dev/panel.ts';
import { loadSandboxSetupFile } from '../data/loader.ts';

const content = loadBrowserContent();
const app = document.getElementById('app') as HTMLElement;
const canvas = document.getElementById('board') as HTMLCanvasElement;
const renderer = new BoardRenderer(canvas, content.board);
const tickRate = content.rules.tickRate;
const moveTicks = Math.max(1, Math.round(content.rules.combat.moveSecondsPerHex * tickRate));
const devBoardNames = DEV_BOARD_NAMES;

let screen: ScreenState = initialScreen();
let hover: Cell | null = null;
let speed = 1;
/** Combat FX toggle (P0-30): client-only rendering setting, never a Command — see the F2 panel's
 *  `fx` checkbox. Defaults on; disabling it only skips `BoardRenderer.drawFx` below. */
let fxOn = true;
/** Shop-card hover (P0-20): shop offers have no uid, so they preview on hover, not click (the
 *  card's click already buys). */
let hoveredShopDefId: string | null = null;
/** The unit inspector's current subject and board origin (for the range ring), or null when
 *  nothing is selected/hovered. Recomputed by `updateInspection` on every relevant change. */
let inspection: { model: InspectorModel; origin: Cell | null } | null = null;
let overlay: DevOverlay | null = null;
let devPanel: DevPanel | null = null;
let fps = 0;
let devFightResult: FightResult | null = null;
/** Final frame of the last dev fight, kept so the idle screen does not rebuild the timeline per frame. */
let devFightFinalFrame: UnitSnapshot[] = [];
/** Unit being dragged with the mouse, the cell it is over, and whether that drop is legal. */
let drag: { uid: number; moved: boolean; cell: Cell | null; drop: DropOutcome | null } | null = null;
/** Set when a drag consumed the gesture, so the trailing `click` does not act on it too. */
let suppressClick = false;
/** Item being dragged with the mouse (P0-29): a run item-bench slot, or a sandbox palette item
 *  id (the sandbox has no bench, so any item def can always be picked up again). Resolved on
 *  mouseup against whatever unit/row the cursor is over; no live hover tracking (unlike unit
 *  drag) since neither screen needs an in-flight highlight to satisfy the acceptance criteria. */
let itemDrag: { kind: 'run'; benchIndex: number } | { kind: 'sandbox'; itemId: string } | null = null;

// ---- screens ----
function emit(ev: ScreenEvent): void {
  const next = reduceScreen(screen, ev);
  if (next === screen) return;
  screen = next;
  syncScreens();
}

const controller = new RunController({
  content,
  // Dev builds accept the `dev:` command namespace (P0-15); `vite build` defines the flag false.
  devCommands: __SIEGE_DEV__,
  onScreenEvent: emit,
  onChange: () => refreshUi(),
});

function dispatch(cmd: Command): { ok: boolean; reason: string | null } {
  return controller.dispatch(cmd);
}

const sandboxController = new SandboxController({ content, onScreenEvent: emit, onChange: () => refreshUi() });

const title = createTitleScreen(app, devBoardNames, content.contentHash, {
  onStartRun(seed) {
    controller.startRun(seed);
  },
  onDevFight(left, right, seed) {
    startDevFight(left, right, seed);
  },
  onSandbox() {
    sandboxController.enter();
  },
});
const results = createResultsScreen(app, {
  onTitle() {
    emit({ type: 'toTitle' });
  },
  onAgain() {
    controller.startRun(Math.floor(Math.random() * 0xffffffff));
  },
});
const pause = createPauseScreen(app, {
  onResume() {
    emit({ type: 'resume' });
  },
  onAbandon() {
    if (screen.screen === 'run' && controller.run) {
      emit({ type: 'resume' });
      controller.abandon();
    } else {
      emit({ type: 'toTitle' });
    }
  },
});
const devBar = document.createElement('div');
devBar.className = 'run-ui';
devBar.hidden = true;
const devBarText = document.createElement('span');
devBarText.className = 'hud';
const devBarBack = document.createElement('button');
devBarBack.className = 'btn';
devBarBack.textContent = 'Back to title';
devBarBack.addEventListener('click', () => emit({ type: 'toTitle' }));
devBar.append(devBarText, devBarBack);
app.appendChild(devBar);

const runUi = createRunUi(app, {
  onCommand(cmd) {
    dispatch(cmd);
  },
  onSelect(uid) {
    controller.selectedUid = uid;
    refreshUi();
  },
  onDragStart(uid) {
    startDrag(uid);
  },
  onItemDragStart(benchIndex) {
    startItemDrag({ kind: 'run', benchIndex });
  },
  onSpeed(s) {
    speed = s;
    refreshUi();
  },
  onPause() {
    emit({ type: 'togglePause' });
  },
  onHoverShop(defId) {
    if (hoveredShopDefId === defId) return;
    hoveredShopDefId = defId;
    updateInspection();
  },
});

const inspectorUi = createInspectorUi(app, {
  onClose() {
    closeInspection();
  },
});

const sandboxUi = createSandboxUi(app, {
  onAddUnit(side, defId) {
    sandboxController.addUnit(side, defId);
  },
  onRemoveUnit(side, index) {
    sandboxController.removeUnit(side, index);
  },
  onItemDragStart(itemId) {
    startItemDrag({ kind: 'sandbox', itemId });
  },
  onSelectUnit(side, index) {
    sandboxController.selectUnit(side, index);
  },
  onSetStar(side, index, star) {
    sandboxController.setStar(side, index, star);
  },
  onSetItems(side, index, items) {
    sandboxController.setItems(side, index, items);
  },
  onSetStatOverride(side, index, stat, value) {
    sandboxController.setStatOverride(side, index, stat, value);
  },
  onSetRules(patch) {
    sandboxController.setRules(patch);
  },
  onSetSeed(seed) {
    sandboxController.setSeed(seed);
  },
  onSetN(n) {
    sandboxController.setN(n);
  },
  onRunOnce() {
    sandboxController.runOnce();
  },
  onReplay() {
    sandboxController.replay();
  },
  onRunN() {
    sandboxController.runN();
  },
  onSave(name) {
    void sandboxController.save(name);
  },
  onLoad(name) {
    void sandboxController.load(name);
  },
  onSpeed(s) {
    speed = s;
    refreshUi();
  },
  onBack() {
    emit({ type: 'toTitle' });
  },
});

function syncScreens(): void {
  const run = controller.run;
  drag = null;
  itemDrag = null;
  // A screen change leaves no shop card under the pointer (or none of this shape), so a stale
  // hover preview must not survive into whatever screen comes next (code review on P0-20).
  hoveredShopDefId = null;
  if (screen.screen === 'title') {
    controller.clear();
    sandboxController.clear();
  }
  title.root.hidden = screen.screen !== 'title';
  runUi.root.hidden = screen.screen !== 'run';
  devBar.hidden = screen.screen !== 'devFight';
  sandboxUi.root.hidden = screen.screen !== 'sandbox';
  if (screen.screen === 'results' && run) {
    results.show({
      outcome: run.outcome ?? 'loss',
      endReason: run.endReason ?? '',
      round: run.round,
      totalRounds: content.encounters.length,
      hp: run.hp,
      seed: run.config.seed,
      finalHash: run.hashes[run.hashes.length - 1] ?? '',
      lines: run.history.map((r) => `round ${String(r.round).padStart(2)}  ${(r.fight ? r.fight.winner : 'skip').padEnd(5)}  hp ${String(r.hpAfter).padStart(3)}  gold ${String(r.gold).padStart(3)}  lvl ${r.level}  ${r.board.join(' ')}`),
    });
  } else {
    results.hide();
  }
  if (screen.paused) pause.show(screen.screen === 'run');
  else pause.hide();
  renderer.resize();
  refreshUi();
}

function startDevFight(left: string, right: string, seed: number): void {
  const l = devBoardUnits(left, content);
  const r = devBoardUnits(right, content);
  devFightResult = fight(l, r, seed, fightRulesFrom(content));
  controller.seed = seed;
  devBarText.textContent = `Dev fight ${left} vs ${right} · seed ${seed} · playing...`;
  const result = devFightResult;
  controller.startPlayback(result, () => {
    devBarText.textContent = `Dev fight ${left} vs ${right} · seed ${seed} · ${result.winner} (${result.reason}) in ${result.ticks} ticks · hash ${result.hash}`;
  });
  const play = controller.playback;
  devFightFinalFrame = play ? (play.timeline.frames[play.timeline.frames.length - 1] ?? []) : [];
  emit({ type: 'startDevFight' });
}

function refreshUi(): void {
  const run = controller.run;
  if (screen.screen === 'run' && run) {
    runUi.update({ state: run, content, mode: controller.mode(), selectedUid: controller.selectedUid, speed, message: controller.message });
  }
  if (screen.screen === 'sandbox') {
    sandboxUi.update({
      content,
      setup: sandboxController.setup,
      seed: sandboxController.seed,
      n: sandboxController.n,
      speed,
      message: sandboxController.message,
      lastAggregate: sandboxController.lastAggregate,
      canReplay: sandboxController.lastResult !== null,
      isPlaying: sandboxController.playback !== null,
      selected: sandboxController.selected,
    });
  }
  updateInspection();
  devPanel?.update({
    seed: screen.screen === 'title' ? null : controller.seed,
    contentHash: content.contentHash,
    round: run?.round ?? null,
    phase: run?.phase ?? null,
    gold: run?.gold ?? null,
    invinciblePieces: run?.dev.invinciblePieces ?? false,
    invinciblePlayer: run?.dev.invinciblePlayer ?? false,
    message: controller.message,
  });
}

// ---- inspector (P0-20) ----

/**
 * The inspector's current subject: a hovered shop card, a selected board/bench unit, or a
 * selected sandbox row (verdict order — a hovered shop card wins so it previews even while a
 * unit stays selected underneath). `origin` is the board cell to draw the range ring around, or
 * null for a bench/shop preview that is not placed anywhere.
 */
function currentInspection(): { model: InspectorModel; origin: Cell | null } | null {
  if (screen.screen === 'run') {
    if (hoveredShopDefId !== null) {
      const model = shopPreviewModel(hoveredShopDefId, content);
      return model ? { model, origin: null } : null;
    }
    const run = controller.run;
    const uid = controller.selectedUid;
    if (!run || uid === null) return null;
    const model = inspectorModel(run, uid, content);
    if (!model) return null;
    const placed = run.board.find((u) => u.uid === uid) ?? null;
    return { model, origin: placed ? { col: placed.col, row: placed.row } : null };
  }
  if (screen.screen === 'sandbox') {
    const sel = sandboxController.selected;
    if (!sel) return null;
    const unit = sandboxController.setup[sel.side][sel.index];
    if (!unit) return null;
    const model = sandboxPreviewModel(unit, content);
    if (!model) return null;
    // The right side is drawn mirrored (drawPlanning mirrors `enemy`), so the ring must be too.
    const origin = sel.side === 'left' ? { col: unit.col, row: unit.row } : mirrorCell({ col: unit.col, row: unit.row }, content.board);
    return { model, origin };
  }
  return null;
}

function updateInspection(): void {
  inspection = currentInspection();
  inspectorUi.update(inspection?.model ?? null);
}

function closeInspection(): boolean {
  if (hoveredShopDefId !== null) hoveredShopDefId = null;
  else if (screen.screen === 'run' && controller.selectedUid !== null) controller.selectedUid = null;
  else if (screen.screen === 'sandbox' && sandboxController.selected !== null) sandboxController.clearSelection();
  else return false;
  refreshUi();
  return true;
}

function currentRangeRing(): RangeRingView | null {
  if (!inspection || !inspection.origin) return null;
  return rangeRings(inspection.model, content, inspection.origin);
}

// ---- input ----
function cellFromEvent(e: MouseEvent): Cell | null {
  const rect = canvas.getBoundingClientRect();
  return renderer.cellAt(e.clientX - rect.left, e.clientY - rect.top);
}

/**
 * Pick a unit up (from the board or a bench card). The selection is left alone: a press that
 * never moves is a click, and the click handler owns it. Drops are resolved on mouseup.
 */
function startDrag(uid: number): void {
  if (itemDrag) return;
  const run = controller.run;
  if (!dragAllowed() || !run || !canDrag(run, uid)) return;
  drag = { uid, moved: false, cell: null, drop: null };
}

function dragAllowed(): boolean {
  return screen.screen === 'run' && controller.run !== null && !controller.playback && !screen.paused;
}

function apply(outcome: PointerOutcome): void {
  if (outcome.command) dispatch(outcome.command);
  else if (outcome.reason) controller.message = outcome.reason;
  if (outcome.select !== 'keep') controller.selectedUid = outcome.select;
  refreshUi();
}

function endDrag(cell: Cell | null): void {
  const d = drag;
  drag = null;
  const run = controller.run;
  if (!d || !run) return;
  if (!d.moved) return; // a click, not a drag: the click handler decides
  suppressClick = true;
  if (!dragAllowed()) return;
  apply(boardDrop(run, d.uid, cell, content));
}

/** Picks an item up (P0-29): a run item-bench card or a sandbox palette card. Unlike unit drag
 *  its mousedown target is never the canvas, so the browser never fires a trailing native `click`
 *  on the drop target for this gesture — no `suppressClick` bookkeeping is needed. */
function startItemDrag(d: NonNullable<typeof itemDrag>): void {
  if (drag) return;
  if (d.kind === 'run') {
    const run = controller.run;
    if (!dragAllowed() || !run || !canDragItem(run, d.benchIndex)) return;
  } else if (screen.screen !== 'sandbox' || screen.paused || sandboxController.playback) {
    return;
  }
  itemDrag = d;
}

/** The unit uid a run item-drop landed on: a board cell (via the canvas) or a bench card
 *  (via its `data-uid`, P0-29). Neither is set when the drop missed both. */
function itemDropTargetUid(e: MouseEvent, run: RunState): number | null {
  if (e.target === canvas) {
    const cell = cellFromEvent(e);
    const occupant = cell ? boardUnitAt(run, cell.col, cell.row) : null;
    return occupant?.uid ?? null;
  }
  const card = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('.bench-card') : null;
  const uid = card?.dataset['uid'];
  return uid !== undefined ? Number(uid) : null;
}

/** The sandbox row a drop landed on, via its `data-side`/`data-index` (P0-29). */
function sandboxDropTarget(e: MouseEvent): { side: SandboxSide; index: number } | null {
  const row = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('.sandbox-unit') : null;
  const side = row?.dataset['side'];
  const index = row?.dataset['index'];
  if (side !== 'left' && side !== 'right') return null;
  if (index === undefined) return null;
  return { side, index: Number(index) };
}

function endItemDrag(e: MouseEvent): void {
  const d = itemDrag;
  itemDrag = null;
  if (!d) return;
  if (d.kind === 'run') {
    const run = controller.run;
    if (!run || !dragAllowed()) return;
    const outcome = itemDropOutcome(run, d.benchIndex, itemDropTargetUid(e, run), content);
    if (outcome.command) dispatch(outcome.command);
    else if (outcome.reason) controller.message = outcome.reason;
    refreshUi();
    return;
  }
  if (screen.screen !== 'sandbox' || screen.paused || sandboxController.playback) return;
  const target = sandboxDropTarget(e);
  const result = target ? sandboxController.dragItemOntoUnit(target.side, target.index, d.itemId) : { ok: false, reason: 'drop an item on a unit' };
  if (!result.ok) sandboxController.message = result.reason ?? '';
  refreshUi();
}

canvas.addEventListener('mousemove', (e) => {
  hover = cellFromEvent(e);
  const run = controller.run;
  if (drag && run) {
    drag.moved = true;
    drag.cell = hover;
    drag.drop = dropOutcome(run, drag.uid, hover, content);
  }
});
canvas.addEventListener('mouseleave', () => {
  hover = null;
  if (drag) {
    drag.cell = null;
    drag.drop = null;
  }
});
canvas.addEventListener('mousedown', (e) => {
  const run = controller.run;
  if (!dragAllowed() || !run) return;
  const cell = cellFromEvent(e);
  if (!cell) return;
  const occupant = boardUnitAt(run, cell.col, cell.row);
  if (occupant) startDrag(occupant.uid);
});
window.addEventListener('mouseup', (e) => {
  if (itemDrag) {
    endItemDrag(e);
    return;
  }
  if (!drag) return;
  const target = e.target === canvas ? cellFromEvent(e) : null;
  endDrag(target);
});
canvas.addEventListener('click', (e) => {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  const run = controller.run;
  if (screen.screen !== 'run' || !run || controller.playback || screen.paused) return;
  const cell = cellFromEvent(e);
  if (!cell || !isPlayerCell(cell, content.board)) return;
  apply(boardClick(run, controller.selectedUid, cell, content));
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'F1') {
    e.preventDefault();
    overlay?.toggle();
    return;
  }
  if (__SIEGE_DEV__ && e.key === 'F2') {
    e.preventDefault();
    devPanel?.toggle();
    refreshUi();
    return;
  }
  // Text inputs and the dev panel's own controls keep their keys (a focused panel button would
  // otherwise re-fire on Space while Space also starts combat); a focused input also keeps its
  // own Escape (e.g. reverting an edit), ahead of the inspector-close carve-out below.
  if (e.target instanceof HTMLInputElement) return;
  if (devPanel && e.target instanceof Node && devPanel.root.contains(e.target)) return;
  // Esc closes the inspector first (P0-20); only once nothing is inspected does it fall through
  // to the pause hotkey below (hotkeyAction's Escape -> pause mapping itself is unchanged: a
  // second Escape press, with nothing left to inspect, still pauses).
  if (e.key === 'Escape' && closeInspection()) {
    e.preventDefault();
    return;
  }
  const action = hotkeyAction(e.key);
  if (!action) return;
  // Speed and pause are view-only: they work while paused and during combat playback.
  if (!isViewAction(action) && (screen.screen !== 'run' || !controller.run || screen.paused || controller.playback)) return;
  const run = controller.run;
  switch (action.type) {
    case 'reroll':
      dispatch({ type: 'reroll' });
      break;
    case 'levelUp':
      dispatch({ type: 'levelUp' });
      break;
    case 'sellSelected':
      if (controller.selectedUid !== null) dispatch({ type: 'sell', uid: controller.selectedUid });
      break;
    case 'startOrNext':
      e.preventDefault();
      if (run) dispatch(run.phase === 'reward' ? { type: 'nextRound' } : { type: 'startCombat' });
      break;
    case 'speed':
      speed = action.speed;
      refreshUi();
      break;
    case 'pause':
      e.preventDefault();
      emit({ type: 'togglePause' });
      break;
    default:
      break;
  }
});
window.addEventListener('resize', () => renderer.resize());

// ---- loop ----
let lastTs = 0;
let fpsAcc = 0;
let fpsFrames = 0;

function frame(ts: number): void {
  const dt = lastTs === 0 ? 0 : Math.min(0.1, (ts - lastTs) / 1000);
  lastTs = ts;
  fpsAcc += dt;
  fpsFrames++;
  if (fpsAcc >= 0.5) {
    fps = fpsFrames / fpsAcc;
    fpsAcc = 0;
    fpsFrames = 0;
  }

  if (!screen.paused) controller.advance(dt, speed);
  const playback = controller.playback;
  const run = controller.run;

  if (screen.screen === 'run' && run) {
    if (playback) drawPlayback(playback);
    else {
      const enc = currentEncounter(run, content);
      renderer.drawPlanning({
        units: run.board,
        enemy: enc ? enc.board : [],
        selectedUid: controller.selectedUid,
        hover,
        content,
        drop: drag?.drop ? { cell: drag.cell, valid: drag.drop.valid } : null,
        rangeRing: currentRangeRing(),
      });
    }
  } else if (screen.screen === 'devFight') {
    if (playback) drawPlayback(playback);
    else if (devFightResult) renderer.drawFight({ frame: devFightFinalFrame, tick: devFightResult.ticks, moveTicks, content });
  } else if (screen.screen === 'sandbox') {
    if (!screen.paused) sandboxController.advance(dt, speed);
    const sandboxPlay = sandboxController.playback;
    if (sandboxPlay) {
      drawPlayback(sandboxPlay, sandboxDisplayContent());
    } else {
      const setup = sandboxController.setup;
      const sel = sandboxController.selected;
      renderer.drawPlanning({
        units: setup.left.map((u, i) => ({ uid: i + 1, defId: u.defId, star: u.star, items: u.items, col: u.col, row: u.row })),
        enemy: setup.right,
        selectedUid: sel && sel.side === 'left' ? sel.index + 1 : null,
        hover,
        content,
        rangeRing: currentRangeRing(),
      });
    }
  } else {
    renderer.drawPlanning({ units: [], enemy: [], selectedUid: null, hover: null, content });
  }

  overlay?.update({
    fps,
    screen: screen.screen + (screen.paused ? ' (paused)' : ''),
    tick: playback ? Math.floor(playback.tick) : null,
    round: run?.round ?? null,
    roundHash: run ? (run.hashes[run.hashes.length - 1] ?? null) : null,
    contentHash: content.contentHash,
    seed: screen.screen === 'title' ? null : controller.seed,
    speed,
    extra: run ? `phase ${run.phase}  gold ${run.gold}  hp ${run.hp}  cmds ${run.commandCount}` : '',
  });
  requestAnimationFrame(frame);
}

function drawPlayback(p: PlaybackState, displayContent: typeof content = content): void {
  const idx = Math.min(p.timeline.frames.length - 1, Math.max(0, Math.floor(p.tick)));
  const frame = p.timeline.frames[idx] ?? [];
  renderer.drawFight({ frame, tick: p.tick, moveTicks, content: displayContent });
  if (fxOn) renderer.drawFx(p.fx, p.tick, frame, moveTicks);
}

/** `content` with the sandbox's synthetic per-instance unit defs merged in, so the renderer's
 *  labels/star work during sandbox playback; the sim never sees this, only `drawFight` does. */
function sandboxDisplayContent(): typeof content {
  const units = sandboxController.lastUnits;
  if (!units) return content;
  return { ...content, unitsById: { ...content.unitsById, ...units } };
}

if (__SIEGE_DEV__) {
  // Dev tools are loaded by URL at runtime so the production bundle carries no dev chunk:
  // the whole branch is dead code in `vite build` (__SIEGE_DEV__ is defined false there,
  // independent of NODE_ENV) and the @vite-ignore keeps Rollup from pre-resolving the import.
  const devModulePath = '../dev/index.ts';
  import(/* @vite-ignore */ devModulePath)
    .then((dev: typeof import('../dev/index.ts')) => {
      overlay = dev.createOverlay(app);
      const cells: Cell[] = [];
      for (let row = 0; row < content.board.rows; row++) {
        for (let col = 0; col < content.board.cols; col++) {
          const cell: Cell = { col, row };
          if (isPlayerCell(cell, content.board)) cells.push(cell);
        }
      }
      devPanel = dev.createDevPanel(app, {
        // The panel goes through the same dispatch as a click or a hotkey: the sim validates,
        // the command lands in the log, and a rejection shows up as the usual message.
        dispatch: (cmd) => dispatch(cmd),
        units: content.units.map((u) => ({ id: u.id, name: u.name, cost: u.cost })),
        maxStar: content.rules.economy.maxStar,
        tiers: shopTierCount(content),
        cells,
        fx: { get: () => fxOn, set: (v) => (fxOn = v) },
      });
      const persistence: SandboxPersistence = {
        async save(name, setup) {
          const res = await dev.writeDataFile(`dev/boards/sandbox-${name}.json`, setup);
          return { ok: res.ok, error: res.ok ? null : (res.error ?? 'save failed') };
        },
        async load(name) {
          const path = `dev/boards/sandbox-${name}.json`;
          const res = await dev.readDataFile(path);
          if (!res.ok) return { ok: false, setup: null, error: res.error ?? 'load failed' };
          try {
            return { ok: true, setup: loadSandboxSetupFile(path, res.value, content), error: null };
          } catch (e) {
            return { ok: false, setup: null, error: e instanceof Error ? e.message : String(e) };
          }
        },
      };
      sandboxController.setPersistence(persistence);
      refreshUi();
    })
    .catch((e: unknown) => console.warn('dev tools unavailable', e));
}

syncScreens();
requestAnimationFrame(frame);
