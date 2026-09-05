import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/data/sha256.ts';
import { canonicalJson, fnv1a32, fnv1a64, hashValue } from '../src/sim/hash.ts';

function fnv1a64BigInt(str: string): string {
  let h = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(str);
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

describe('canonicalJson', () => {
  it('sorts keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { z: [3, 2, 1], y: 'x' } })).toBe('{"a":{"y":"x","z":[3,2,1]},"b":1}');
  });
  it('drops undefined object values and turns undefined array items into null', () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
  });
  it('rejects NaN and Infinity', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson([Number.POSITIVE_INFINITY])).toThrow();
  });
  it('normalises -0', () => {
    expect(canonicalJson(-0)).toBe('0');
  });
});

describe('fnv1a64', () => {
  it('matches the BigInt reference on known vectors', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325');
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c');
    expect(fnv1a64('foobar')).toBe('85944171f73967e8');
  });
  it('matches the BigInt reference on random and non-ASCII strings', () => {
    const samples = ['siege', '{"a":1}', 'héllo wörld', '日本語', '😀 emoji', 'x'.repeat(1000), JSON.stringify({ k: [1, 2, 3], s: 'v' })];
    for (let i = 0; i < 200; i++) samples.push(String(i * 7919) + 'abc' + String(i));
    for (const s of samples) expect(fnv1a64(s), s).toBe(fnv1a64BigInt(s));
  });
  it('fnv1a32 known vector', () => {
    expect(fnv1a32('a')).toBe(0xe40c292c);
  });
  it('hashValue is stable across key order', () => {
    expect(hashValue({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(hashValue({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });
});

describe('sha256', () => {
  it('matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    expect(sha256Hex('a'.repeat(1000))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
  });
});
