// Canvas 2D renderer for the hex board. Reads sim state / timeline snapshots; never mutates them.
import type { UnitSnapshot } from './timeline.ts';
import { interpolatedCell } from './timeline.ts';
import type { BoardConfig, Cell } from '../sim/hex.ts';
import { mirrorCell } from '../sim/hex.ts';
import type { Content } from '../sim/rules.ts';
import type { BoardUnit, PlacedUnit } from '../sim/units.ts';
import { letterbox, type Box } from './layout.ts';

const SQRT3 = Math.sqrt(3);

export interface PlanningView {
  units: PlacedUnit[];
  /** Encounter board in owner-half coordinates; drawn mirrored as a preview. */
  enemy: BoardUnit[];
  selectedUid: number | null;
  hover: Cell | null;
  content: Content;
  /** Cell under a dragged unit, highlighted green when the drop is legal and red when not. */
  drop?: { cell: Cell | null; valid: boolean } | null;
}

export interface FightView {
  frame: UnitSnapshot[];
  /** Fractional tick for interpolation. */
  tick: number;
  moveTicks: number;
  content: Content;
}

const COLORS = {
  bg: '#101418',
  cellPlayer: '#1f2a33',
  cellEnemy: '#2b1f22',
  cellLine: '#2f3b46',
  hover: '#3d5a73',
  dropOk: '#22c55e',
  dropBad: '#ef4444',
  letterbox: '#07090b',
  selected: '#c9a227',
  teamLeft: '#3b82f6',
  teamRight: '#ef4444',
  hp: '#22c55e',
  hpBg: '#3f1d1d',
  mana: '#38bdf8',
  manaBg: '#1e2a3a',
  text: '#e5e7eb',
  stun: '#facc15',
};

export class BoardRenderer {
  private ctx: CanvasRenderingContext2D;
  private size = 24;
  private originX = 0;
  private originY = 0;
  private width = 0;
  private height = 0;
  private play: Box = { x: 0, y: 0, width: 0, height: 0 };

  private readonly canvas: HTMLCanvasElement;
  private readonly board: BoardConfig;

  constructor(canvas: HTMLCanvasElement, board: BoardConfig) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.canvas = canvas;
    this.board = board;
    this.ctx = ctx;
    this.resize();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // The board lives inside a fixed-aspect play area; the rest of the canvas is letterbox.
    this.play = letterbox(this.width, this.height);
    const cols = this.board.cols + 0.5;
    const rows = this.board.rows;
    const sizeByWidth = this.play.width / (SQRT3 * cols) - 1;
    const sizeByHeight = this.play.height / (1.5 * rows + 0.5) - 1;
    this.size = Math.max(8, Math.floor(Math.min(sizeByWidth, sizeByHeight)));
    const gridW = SQRT3 * this.size * cols;
    const gridH = this.size * (1.5 * rows + 0.5);
    this.originX = this.play.x + (this.play.width - gridW) / 2;
    this.originY = this.play.y + (this.play.height - gridH) / 2;
  }


  cellCenter(col: number, row: number): { x: number; y: number } {
    const w = SQRT3 * this.size;
    const shift = (Math.floor(row) & 1) * 0.5;
    return {
      x: this.originX + w * (col + shift) + w / 2,
      y: this.originY + 1.5 * this.size * row + this.size,
    };
  }

  /** Cell under CSS-pixel canvas coordinates, or null. */
  cellAt(x: number, y: number): Cell | null {
    let best: Cell | null = null;
    let bestD = this.size * this.size;
    for (let row = 0; row < this.board.rows; row++) {
      for (let col = 0; col < this.board.cols; col++) {
        const c = this.cellCenter(col, row);
        const d = (c.x - x) * (c.x - x) + (c.y - y) * (c.y - y);
        if (d < bestD) {
          bestD = d;
          best = { col, row };
        }
      }
    }
    return best;
  }

  private hexPath(x: number, y: number, size: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) {
      const angle = (Math.PI / 180) * (60 * k - 30);
      const px = x + size * Math.cos(angle);
      const py = y + size * Math.sin(angle);
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  private drawGrid(hover: Cell | null, drop: { cell: Cell | null; valid: boolean } | null = null): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.letterbox;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(this.play.x, this.play.y, this.play.width, this.play.height);
    const playerStart = this.board.rows - this.board.playerRows;
    for (let row = 0; row < this.board.rows; row++) {
      for (let col = 0; col < this.board.cols; col++) {
        const c = this.cellCenter(col, row);
        this.hexPath(c.x, c.y, this.size - 1);
        const isHover = hover !== null && hover.col === col && hover.row === row;
        ctx.fillStyle = isHover ? COLORS.hover : row >= playerStart ? COLORS.cellPlayer : COLORS.cellEnemy;
        ctx.fill();
        const isDrop = drop?.cell != null && drop.cell.col === col && drop.cell.row === row;
        ctx.strokeStyle = isDrop ? (drop.valid ? COLORS.dropOk : COLORS.dropBad) : COLORS.cellLine;
        ctx.lineWidth = isDrop ? 3 : 1;
        ctx.stroke();
      }
    }
  }

  private drawUnit(x: number, y: number, opts: { team: 0 | 1; label: string; star: number; hp: number; maxHp: number; mana: number; maxMana: number; selected: boolean; flash: boolean; stunned: boolean; alpha: number }): void {
    const ctx = this.ctx;
    const r = this.size * 0.62;
    ctx.save();
    ctx.globalAlpha = opts.alpha;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = opts.flash ? '#ffffff' : opts.team === 0 ? COLORS.teamLeft : COLORS.teamRight;
    ctx.fill();
    if (opts.selected) {
      ctx.strokeStyle = COLORS.selected;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    if (opts.stunned) {
      ctx.strokeStyle = COLORS.stun;
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = COLORS.text;
    ctx.font = `${Math.max(9, Math.floor(this.size * 0.55))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(opts.label, x, y);
    // star pips
    const pipY = y - r - 4;
    for (let s = 0; s < opts.star; s++) {
      ctx.beginPath();
      ctx.arc(x + (s - (opts.star - 1) / 2) * 6, pipY, 2, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.selected;
      ctx.fill();
    }
    // bars
    const bw = r * 2;
    const bx = x - r;
    const hpY = y + r + 2;
    ctx.fillStyle = COLORS.hpBg;
    ctx.fillRect(bx, hpY, bw, 4);
    ctx.fillStyle = COLORS.hp;
    ctx.fillRect(bx, hpY, bw * Math.max(0, Math.min(1, opts.maxHp > 0 ? opts.hp / opts.maxHp : 0)), 4);
    if (opts.maxMana > 0) {
      ctx.fillStyle = COLORS.manaBg;
      ctx.fillRect(bx, hpY + 5, bw, 3);
      ctx.fillStyle = COLORS.mana;
      ctx.fillRect(bx, hpY + 5, bw * Math.max(0, Math.min(1, opts.mana / opts.maxMana)), 3);
    }
    ctx.restore();
  }

  private label(defId: string, content: Content): string {
    const def = content.unitsById[defId];
    const name = def ? def.name.replace(/^Dev /, '') : defId;
    return name.slice(0, 3).toUpperCase();
  }

  drawPlanning(view: PlanningView): void {
    this.drawGrid(view.hover, view.drop ?? null);
    for (const e of view.enemy) {
      const m = mirrorCell(e, this.board);
      const c = this.cellCenter(m.col, m.row);
      const def = view.content.unitsById[e.defId];
      const stats = def?.stats[e.star - 1];
      this.drawUnit(c.x, c.y, {
        team: 1,
        label: this.label(e.defId, view.content),
        star: e.star,
        hp: 1,
        maxHp: 1,
        mana: stats?.startMana ?? 0,
        maxMana: stats?.maxMana ?? 0,
        selected: false,
        flash: false,
        stunned: false,
        alpha: 0.55,
      });
    }
    for (const u of view.units) {
      const c = this.cellCenter(u.col, u.row);
      const def = view.content.unitsById[u.defId];
      const stats = def?.stats[u.star - 1];
      this.drawUnit(c.x, c.y, {
        team: 0,
        label: this.label(u.defId, view.content),
        star: u.star,
        hp: 1,
        maxHp: 1,
        mana: stats?.startMana ?? 0,
        maxMana: stats?.maxMana ?? 0,
        selected: view.selectedUid === u.uid,
        flash: false,
        stunned: false,
        alpha: 1,
      });
    }
  }

  drawFight(view: FightView): void {
    this.drawGrid(null);
    const sorted = [...view.frame].sort((a, b) => a.row - b.row || a.uid - b.uid);
    for (const u of sorted) {
      if (!u.alive) continue;
      const p = interpolatedCell(u, view.tick, view.moveTicks);
      const c = this.cellCenter(p.col, p.row);
      this.drawUnit(c.x, c.y, {
        team: u.team,
        label: this.label(u.defId, view.content),
        star: u.star,
        hp: u.hp,
        maxHp: u.maxHp,
        mana: u.mana,
        maxMana: u.maxMana,
        selected: false,
        flash: u.lastHitTick >= 0 && view.tick - u.lastHitTick < 3,
        stunned: view.tick < u.stunnedUntil,
        alpha: 1,
      });
    }
  }
}
