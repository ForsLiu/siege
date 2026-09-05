// Seeded RNG (sfc32) with named streams derived from (runSeed, streamName).
// Pure; serialisable state so run state hashes and replays cover the generator.
import { fnv1a32 } from './hash.ts';

export const STREAM_NAMES = ['shop', 'encounter', 'combat', 'loot', 'augment', 'misc'] as const;
export type StreamName = (typeof STREAM_NAMES)[number];

export interface RngState {
  a: number;
  b: number;
  c: number;
  d: number;
}

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
}

export function deriveStreamState(runSeed: number, streamName: string): RngState {
  const mixed = (fnv1a32(streamName) ^ Math.imul(runSeed >>> 0, 0x9e3779b1)) >>> 0;
  const sm = splitmix32(mixed);
  const st: RngState = { a: sm(), b: sm(), c: sm(), d: sm() };
  const r = new Rng(st);
  for (let i = 0; i < 12; i++) r.nextU32();
  return r.state();
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(state: RngState) {
    this.a = state.a >>> 0;
    this.b = state.b >>> 0;
    this.c = state.c >>> 0;
    this.d = state.d >>> 0;
  }

  static fromSeed(runSeed: number, streamName: string): Rng {
    return new Rng(deriveStreamState(runSeed, streamName));
  }

  state(): RngState {
    return { a: this.a, b: this.b, c: this.c, d: this.d };
  }

  clone(): Rng {
    return new Rng(this.state());
  }

  nextU32(): number {
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    this.a >>>= 0;
    this.b >>>= 0;
    this.c >>>= 0;
    this.d >>>= 0;
    return t >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform integer in [0, n). n must be a positive integer. */
  int(n: number): number {
    if (!(n > 0) || !Number.isInteger(n)) throw new Error(`Rng.int: n must be a positive integer, got ${n}`);
    return Math.floor(this.next() * n);
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('Rng.pick: empty array');
    return arr[this.int(arr.length)] as T;
  }

  /** In-place Fisher-Yates shuffle; returns the same array. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = arr[i] as T;
      arr[i] = arr[j] as T;
      arr[j] = tmp;
    }
    return arr;
  }
}

export type RngStates = Record<StreamName, RngState>;

export function createRngStates(runSeed: number): RngStates {
  const out = {} as RngStates;
  for (const name of STREAM_NAMES) out[name] = deriveStreamState(runSeed, name);
  return out;
}
