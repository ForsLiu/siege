// App glue: content -> sim run -> renderer/UI, screen state machine, input mapping, game loop.
// The sim is driven exclusively through Commands; rendering reads state and fight events.
import './style.css';
import { DEV_BOARD_NAMES, devBoardUnits, loadBrowserContent } from '../data/browser.ts';
import { BoardRenderer } from '../render/board.ts';
import { buildTimeline, type Timeline, type UnitSnapshot } from '../render/timeline.ts';
import { applyCommand, type Command } from '../sim/commands.ts';
import { fight, type FightResult } from '../sim/fight.ts';
import type { Cell } from '../sim/hex.ts';
import { isPlayerCell } from '../sim/hex.ts';
import { fightRulesFrom } from '../sim/rules.ts';
import { boardUnitAt, createRun, currentEncounter, findUnit, type RunState } from '../sim/run.ts';
import { createPauseScreen, createResultsScreen, createTitleScreen } from '../ui/screens.ts';
import { createRunUi, type RunUiMode } from '../ui/runUi.ts';
import { initialScreen, reduceScreen, type ScreenEvent, type ScreenState } from './screens.ts';
import type { DevOverlay } from '../dev/overlay.ts';

const content = loadBrowserContent();
const app = document.getElementById('app') as HTMLElement;
const canvas = document.getElementById('board') as HTMLCanvasElement;
const renderer = new BoardRenderer(canvas, content.board);
const tickRate = content.rules.tickRate;
const moveTicks = Math.max(1, Math.round(content.rules.combat.moveSecondsPerHex * tickRate));
const devBoardNames = DEV_BOARD_NAMES;

interface Playback {
  timeline: Timeline;
  tick: number;
  done: boolean;
  onDone: () => void;
}

let screen: ScreenState = initialScreen();
let run: RunState | null = null;
let runSeed = 0;
let selectedUid: number | null = null;
let hover: Cell | null = null;
let speed = 1;
let playback: Playback | null = null;
let message = '';
let overlay: DevOverlay | null = null;
let fps = 0;
let devFightResult: FightResult | null = null;
/** Final frame of the last dev fight, kept so the idle screen does not rebuild the timeline per frame. */
let devFightFinalFrame: UnitSnapshot[] = [];

// ---- screens ----
function emit(ev: ScreenEvent): void {
  const next = reduceScreen(screen, ev);
  if (next === screen) return;
  screen = next;
  syncScreens();
}

const title = createTitleScreen(app, devBoardNames, content.contentHash, {
  onStartRun(seed) {
    startRun(seed);
  },
  onDevFight(left, right, seed) {
    startDevFight(left, right, seed);
  },
});
const results = createResultsScreen(app, {
  onTitle() {
    emit({ type: 'toTitle' });
  },
  onAgain() {
    startRun(Math.floor(Math.random() * 0xffffffff));
  },
});
const pause = createPauseScreen(app, {
  onResume() {
    emit({ type: 'resume' });
  },
  onAbandon() {
    if (screen.screen === 'run' && run) {
      // Abandoning mid-fight: the fight is already resolved in the sim; drop the playback.
      playback = null;
      emit({ type: 'resume' });
      dispatch({ type: 'abandon' });
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
    selectedUid = uid;
    refreshUi();
  },
  onSpeed(s) {
    speed = s;
    refreshUi();
  },
  onPause() {
    emit({ type: 'togglePause' });
  },
});

function syncScreens(): void {
  if (screen.screen === 'title') playback = null;
  title.root.hidden = screen.screen !== 'title';
  runUi.root.hidden = screen.screen !== 'run';
  devBar.hidden = screen.screen !== 'devFight';
  if (screen.screen === 'results' && run) {
    results.show({
      outcome: run.outcome ?? 'loss',
      endReason: run.endReason ?? '',
      round: run.round,
      totalRounds: content.encounters.length,
      hp: run.hp,
      seed: run.config.seed,
      finalHash: run.hashes[run.hashes.length - 1] ?? '',
      lines: run.history.map((r) => `round ${String(r.round).padStart(2)}  ${r.fight.winner.padEnd(5)}  hp ${String(r.hpAfter).padStart(3)}  gold ${String(r.gold).padStart(3)}  lvl ${r.level}  ${r.board.join(' ')}`),
    });
  } else {
    results.hide();
  }
  if (screen.paused) pause.show(screen.screen === 'run');
  else pause.hide();
  renderer.resize();
  refreshUi();
}

// ---- run control ----
function startRun(seed: number): void {
  run = createRun(seed, content);
  runSeed = seed;
  selectedUid = null;
  playback = null;
  message = '';
  emit({ type: 'startRun' });
  refreshUi();
}

function dispatch(cmd: Command): void {
  if (!run || playback) return;
  const res = applyCommand(run, cmd, content);
  if (!res.ok) {
    message = res.reason;
    refreshUi();
    return;
  }
  message = '';
  if (selectedUid !== null && !findUnit(run, selectedUid)) selectedUid = null;
  if (res.fight) {
    const fightResult = res.fight;
    startPlayback(fightResult, () => {
      const r = run;
      if (!r) return;
      const f = r.lastFight;
      message = f ? `${f.winner === 'left' ? 'Victory' : f.winner === 'right' ? 'Defeat' : 'Draw'} in ${(f.ticks / tickRate).toFixed(1)}s (-${f.hpLoss} hp)` : '';
      if (r.phase === 'ended') finishRun();
      else refreshUi();
    });
  } else if (run.phase === 'ended') {
    finishRun();
  }
  refreshUi();
}

function finishRun(): void {
  if (!run) return;
  emit({ type: 'runEnded', outcome: run.outcome ?? 'loss' });
}

function startPlayback(result: FightResult, onDone: () => void): void {
  playback = { timeline: buildTimeline(result, moveTicks), tick: 0, done: false, onDone };
}

function startDevFight(left: string, right: string, seed: number): void {
  const l = devBoardUnits(left, content);
  const r = devBoardUnits(right, content);
  devFightResult = fight(l, r, seed, fightRulesFrom(content));
  runSeed = seed;
  devBarText.textContent = `Dev fight ${left} vs ${right} · seed ${seed} · playing...`;
  const result = devFightResult;
  startPlayback(result, () => {
    devBarText.textContent = `Dev fight ${left} vs ${right} · seed ${seed} · ${result.winner} (${result.reason}) in ${result.ticks} ticks · hash ${result.hash}`;
  });
  devFightFinalFrame = playback ? (playback.timeline.frames[playback.timeline.frames.length - 1] ?? []) : [];
  emit({ type: 'startDevFight' });
}

function uiMode(): RunUiMode {
  if (playback) return 'combat';
  if (run?.phase === 'reward') return 'reward';
  return 'planning';
}

function refreshUi(): void {
  if (screen.screen === 'run' && run) runUi.update({ state: run, content, mode: uiMode(), selectedUid, speed, message });
}

// ---- input ----
canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  hover = renderer.cellAt(e.clientX - rect.left, e.clientY - rect.top);
});
canvas.addEventListener('mouseleave', () => {
  hover = null;
});
canvas.addEventListener('click', (e) => {
  if (screen.screen !== 'run' || !run || playback || screen.paused || run.phase !== 'planning') return;
  const rect = canvas.getBoundingClientRect();
  const cell = renderer.cellAt(e.clientX - rect.left, e.clientY - rect.top);
  if (!cell || !isPlayerCell(cell, content.board)) return;
  const occupant = boardUnitAt(run, cell.col, cell.row);
  if (occupant) {
    if (selectedUid === occupant.uid) {
      dispatch({ type: 'bench', uid: occupant.uid });
      selectedUid = null;
    } else if (selectedUid !== null) {
      dispatch({ type: 'swap', uidA: selectedUid, uidB: occupant.uid });
      selectedUid = null;
    } else {
      selectedUid = occupant.uid;
    }
  } else if (selectedUid !== null) {
    dispatch({ type: 'place', uid: selectedUid, col: cell.col, row: cell.row });
    if (run.board.some((u) => u.uid === selectedUid)) selectedUid = null;
  }
  refreshUi();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'F1') {
    e.preventDefault();
    overlay?.toggle();
    return;
  }
  if (e.key === 'Escape') {
    emit({ type: 'togglePause' });
    return;
  }
  if (screen.screen !== 'run' || !run || screen.paused || playback) return;
  if (e.target instanceof HTMLInputElement) return;
  switch (e.key) {
    case 'r':
    case 'R':
      dispatch({ type: 'reroll' });
      break;
    case 'x':
    case 'X':
      dispatch({ type: 'levelUp' });
      break;
    case 's':
    case 'S':
      if (selectedUid !== null) dispatch({ type: 'sell', uid: selectedUid });
      break;
    case ' ':
      e.preventDefault();
      dispatch(run.phase === 'reward' ? { type: 'nextRound' } : { type: 'startCombat' });
      break;
    case '1':
      speed = 1;
      refreshUi();
      break;
    case '2':
      speed = 2;
      refreshUi();
      break;
    case '3':
      speed = 4;
      refreshUi();
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

  if (playback && !playback.done && !screen.paused) {
    playback.tick += dt * tickRate * speed;
    if (playback.tick >= playback.timeline.ticks + tickRate * 0.5) {
      playback.done = true;
      const done = playback.onDone;
      playback = null;
      done();
      refreshUi();
    }
  }

  if (screen.screen === 'run' && run) {
    if (playback) drawPlayback(playback);
    else {
      const enc = currentEncounter(run, content);
      renderer.drawPlanning({ units: run.board, enemy: enc ? enc.board : [], selectedUid, hover, content });
    }
  } else if (screen.screen === 'devFight') {
    if (playback) drawPlayback(playback);
    else if (devFightResult) renderer.drawFight({ frame: devFightFinalFrame, tick: devFightResult.ticks, moveTicks, content });
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
    seed: screen.screen === 'title' ? null : runSeed,
    speed,
    extra: run ? `phase ${run.phase}  gold ${run.gold}  hp ${run.hp}  cmds ${run.commandCount}` : '',
  });
  requestAnimationFrame(frame);
}

function drawPlayback(p: Playback): void {
  const idx = Math.min(p.timeline.frames.length - 1, Math.max(0, Math.floor(p.tick)));
  renderer.drawFight({ frame: p.timeline.frames[idx] ?? [], shots: p.timeline.shots[idx] ?? [], tick: p.tick, moveTicks, content });
}

if (__SIEGE_DEV__) {
  // Dev tools are loaded by URL at runtime so the production bundle carries no dev chunk:
  // the whole branch is dead code in `vite build` (__SIEGE_DEV__ is defined false there,
  // independent of NODE_ENV) and the @vite-ignore keeps Rollup from pre-resolving the import.
  const devModulePath = '../dev/index.ts';
  import(/* @vite-ignore */ devModulePath)
    .then((dev: typeof import('../dev/index.ts')) => {
      overlay = dev.createOverlay(app);
    })
    .catch((e: unknown) => console.warn('dev tools unavailable', e));
}

syncScreens();
requestAnimationFrame(frame);
