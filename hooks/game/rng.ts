// A small seeded generator (mulberry32) so a floor, a fight and a drop replay the same from the
// same seed: the tests lean on that, and so does regenerating a floor after compaction.

export type Rng = {
  next: () => number
  int: (n: number) => number
  range: (lo: number, hi: number) => number
  pick: <T>(items: readonly T[]) => T
  chance: (p: number) => boolean
  weighted: (weights: readonly number[]) => number
  seed: () => number
}

export function rng(seed: number): Rng {
  let s = (seed >>> 0) || 1
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (n: number) => Math.floor(next() * n)
  return {
    next,
    int,
    range: (lo, hi) => lo + int(hi - lo + 1),
    pick: items => items[int(items.length)],
    chance: p => next() < p,
    weighted: weights => {
      const total = weights.reduce((a, b) => a + b, 0)
      let roll = next() * total
      for (let i = 0; i < weights.length; i++) {
        roll -= weights[i]
        if (roll < 0) return i
      }
      return weights.length - 1
    },
    seed: () => s,
  }
}
