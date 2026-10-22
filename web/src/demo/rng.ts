/** Deterministic randomness for demo fixtures: same inputs, same numbers, every load. */

/** FNV-1a over the string form of the parts; a stable 32-bit seed. */
export function hashSeed(...parts: Array<string | number>): number {
  let h = 0x811c9dc5;
  const s = parts.join('|');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Rng {
  /** Uniform [0, 1). */
  next(): number;
  range(min: number, max: number): number;
  int(min: number, maxInclusive: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Picks by relative weight. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  /** Multiplicative jitter around 1: 1 +/- spread. */
  jitter(spread: number): number;
}

/** mulberry32 */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r: Rng = {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)]!,
    weighted: (items, weights) => {
      const total = weights.reduce((s, w) => s + w, 0);
      let x = next() * total;
      for (let i = 0; i < items.length; i++) {
        x -= weights[i]!;
        if (x < 0) return items[i]!;
      }
      return items[items.length - 1]!;
    },
    jitter: (spread) => 1 + (next() * 2 - 1) * spread,
  };
  return r;
}

export function rngFor(...parts: Array<string | number>): Rng {
  return rng(hashSeed(...parts));
}

/** Pseudo-uuid made of hex from a seed (synthetic ids only). */
export function fakeUuid(...parts: Array<string | number>): string {
  const r = rngFor('uuid', ...parts);
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(r.next() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}
