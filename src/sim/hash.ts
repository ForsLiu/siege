// Canonical JSON + FNV-1a hashing. Pure; no platform APIs.
//
// canonicalJson: object keys sorted, arrays in order, `undefined` object values dropped,
// numbers printed via JSON.stringify (NaN / Infinity throw: they must never reach a hash).
// fnv1a64: 64-bit FNV-1a over the UTF-8 bytes of the string, computed with two 32-bit
// halves (no BigInt) and returned as 16 lowercase hex digits.

export function canonicalJson(value: unknown): string {
  const parts: string[] = [];
  writeCanonical(value, parts);
  return parts.join('');
}

function writeCanonical(value: unknown, out: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number ${String(value)}`);
      out.push(Object.is(value, -0) ? '0' : JSON.stringify(value));
      return;
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'undefined':
      throw new Error('canonicalJson: undefined is not serialisable at this position');
    case 'object': {
      if (Array.isArray(value)) {
        out.push('[');
        for (let i = 0; i < value.length; i++) {
          if (i > 0) out.push(',');
          const v = value[i];
          writeCanonical(v === undefined ? null : v, out);
        }
        out.push(']');
        return;
      }
      if (value instanceof Map || value instanceof Set) {
        throw new Error('canonicalJson: Map/Set are not serialisable (use arrays)');
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      out.push('{');
      let first = true;
      for (const k of keys) {
        const v = obj[k];
        if (v === undefined) continue;
        if (!first) out.push(',');
        first = false;
        out.push(JSON.stringify(k), ':');
        writeCanonical(v, out);
      }
      out.push('}');
      return;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

const FNV64_OFFSET_HI = 0xcbf29ce4;
const FNV64_OFFSET_LO = 0x84222325;
// FNV 64 prime = 2^40 + 0x1b3. h * prime mod 2^64 = (h << 40) + h * 0x1b3.
const FNV64_PRIME_LOW = 0x1b3;

function utf8Bytes(str: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
      const d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
        bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      } else {
        bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return bytes;
}

export function fnv1a64(str: string): string {
  let hi = FNV64_OFFSET_HI;
  let lo = FNV64_OFFSET_LO;
  const n = str.length;
  let asciiOnly = true;
  for (let i = 0; i < n; i++) {
    if (str.charCodeAt(i) >= 0x80) {
      asciiOnly = false;
      break;
    }
  }
  const step = (byte: number): void => {
    lo = (lo ^ byte) >>> 0;
    // multiply (hi:lo) by prime modulo 2^64
    const loProd = lo * FNV64_PRIME_LOW; // < 2^41, exact
    const newLo = loProd % 4294967296;
    const carry = Math.floor(loProd / 4294967296);
    const shifted = (lo * 256) % 4294967296; // (lo << 40) contributes lo<<8 into hi
    const hiProd = (hi * FNV64_PRIME_LOW) % 4294967296;
    hi = (shifted + hiProd + carry) % 4294967296;
    lo = newLo;
  };
  if (asciiOnly) {
    for (let i = 0; i < n; i++) step(str.charCodeAt(i));
  } else {
    for (const b of utf8Bytes(str)) step(b);
  }
  return hex32(hi) + hex32(lo);
}

function hex32(v: number): string {
  return (v >>> 0).toString(16).padStart(8, '0');
}

export function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (const b of utf8Bytes(str)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Hash any JSON-serialisable value: canonical JSON -> FNV-1a 64 (hex). */
export function hashValue(value: unknown): string {
  return fnv1a64(canonicalJson(value));
}
