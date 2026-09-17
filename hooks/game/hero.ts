import { bonus, itemScore, SLOTS, type Item, type Slot } from './items.ts'

// Kaneed's sheet. Pure data, JSON-safe: the hooks module keeps it in $.store between sessions and
// hands it back to the board on the next start, so a run continues where it left off.

export type Equipment = Record<Slot, Item | null>
export type Hero = {
  lv: number
  xp: number
  hp: number
  gold: number
  kills: number
  steps: number
  floor: number
  run: number
  equipment: Equipment
  bornAt: number
}

export type Stats = { maxHp: number; atk: number; def: number; crit: number; evade: number }

export const emptyEquipment = (): Equipment => ({ hat: null, eyewear: null, shield: null, sword: null, boots: null })

export function newHero(run: number, now: number): Hero {
  const h: Hero = { lv: 1, xp: 0, hp: 0, gold: 0, kills: 0, steps: 0, floor: 1, run, equipment: emptyEquipment(), bornAt: now }
  h.hp = stats(h).maxHp
  return h
}

// base numbers grow with the level; equipment adds on top. Critical and evade are percentages.
export function stats(h: Hero): Stats {
  const s: Stats = { maxHp: 50 + 10 * (h.lv - 1), atk: 6 + 2 * h.lv, def: 2 + 0.5 * h.lv, crit: 5, evade: 5 }
  for (const slot of SLOTS) {
    const item = h.equipment[slot]
    if (!item) continue
    const b = bonus(item)
    s.maxHp += b.maxHp
    s.atk += b.atk
    s.def += b.def
    s.crit += b.crit
    s.evade += b.evade
  }
  s.maxHp = Math.round(s.maxHp)
  s.crit = Math.min(50, s.crit)
  s.evade = Math.min(50, s.evade)
  return s
}

// level n to n+1: quadratic, so later levels take more kills than the enemies get harder
export const xpNeeded = (lv: number) => 30 + 25 * lv + 3 * lv * lv
export const HEAL_ON_LEVEL = 0.5

// the two ways Kaneed heals for free: a level up gives half the bar back, a passing test run a third.
// Neither fills it, so the bar drifts down over a run; a shop, when one turns up, sells the rest.
export function gainXp(h: Hero, xp: number): { hero: Hero; levels: number } {
  let hero = { ...h, xp: h.xp + xp }
  let levels = 0
  while (hero.xp >= xpNeeded(hero.lv)) {
    hero = { ...hero, xp: hero.xp - xpNeeded(hero.lv), lv: hero.lv + 1 }
    levels++
  }
  if (levels > 0) hero = heal(hero, HEAL_ON_LEVEL * levels).hero
  return { hero, levels }
}

export function heal(h: Hero, ratio: number): { hero: Hero; healed: number } {
  const max = stats(h).maxHp
  const hp = Math.min(max, h.hp + Math.round(max * ratio))
  return { hero: { ...h, hp }, healed: hp - h.hp }
}

export function damage(h: Hero, amount: number): Hero {
  return { ...h, hp: Math.max(0, h.hp - amount) }
}

// a found item is always worn, whatever was in the slot: Kaneed cannot tell a downgrade from an
// upgrade until it is on. `better` says which it was, for the log. A hat that adds hit points
// lifts the current hp by the difference; one that takes them away caps hp at the new maximum.
export function equip(h: Hero, item: Item): { hero: Hero; replaced: Item | null; better: boolean } {
  const current = h.equipment[item.slot]
  const before = stats(h).maxHp
  const hero: Hero = { ...h, equipment: { ...h.equipment, [item.slot]: item } }
  const after = stats(hero).maxHp
  const hp = Math.max(1, Math.min(after, hero.hp + Math.max(0, after - before)))
  return { hero: { ...hero, hp }, replaced: current, better: !current || itemScore(item) > itemScore(current) }
}

export const isHero = (v: unknown): v is Hero =>
  typeof v === 'object' && v !== null && typeof (v as Hero).lv === 'number' && typeof (v as Hero).hp === 'number' && typeof (v as Hero).equipment === 'object'
