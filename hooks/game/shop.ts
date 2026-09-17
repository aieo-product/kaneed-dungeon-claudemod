import type { Rng } from './rng.ts'
import { bonus, isWizardItem, itemName, itemScore, rarityName, rollItem, type Item } from './items.ts'

// The shop: a counter some floors keep in one of their rooms, and the one place the gold goes.
// Kaneed can only shop when it finds one. The shelf holds three wares, rolled when it walks in; it
// buys one of those it can afford, at random, and goes on its way. Nothing is bought from afar.

export const SHELF_SIZE = 3
// the chance a floor has a shop at all
export const SHOP_CHANCE = 0.5

export type Remedy = 'herb' | 'potion'
export type Ware = { kind: Remedy } | { kind: 'gear'; item: Item }

export const REMEDIES: Record<Remedy, { name: string; ratio: number }> = {
  herb: { name: '薬草', ratio: 0.3 },
  potion: { name: '回復薬', ratio: 1 },
}

// a kill is worth 2 to 4+lv gold: a herb costs a handful of kills, a full heal a floor's work, and
// a piece of equipment from 20 G (a tier-1 common) to some 730 G (a tier-5 legend)
export function priceOf(w: Ware, lv: number): number {
  if (w.kind === 'gear') return Math.round(20 * itemScore(w.item) ** 1.5)
  return w.kind === 'herb' ? 15 + 5 * lv : 50 + 15 * lv
}

export const wareName = (w: Ware) => (w.kind === 'gear' ? `${itemName(w.item)}［${rarityName(w.item)}］${isWizardItem(w.item) ? '✦' : ''}` : REMEDIES[w.kind].name)

// one line of what a ware does
export function wareNote(w: Ware): string {
  if (w.kind !== 'gear') return w.kind === 'herb' ? 'HP 30% 回復' : 'HP 全回復'
  const b = bonus(w.item)
  if (b.atk) return `攻撃 +${b.atk.toFixed(1)}`
  if (b.def) return `防御 +${b.def.toFixed(1)}`
  if (b.maxHp) return `最大 HP +${Math.round(b.maxHp)}`
  if (b.crit) return `会心 +${b.crit.toFixed(0)}%`
  return `回避 +${b.evade.toFixed(0)}%`
}

// remedies and equipment in about equal measure; the equipment a step ahead of what the floor drops
export function rollShelf(r: Rng, power: number): Ware[] {
  const shelf: Ware[] = []
  for (let i = 0; i < SHELF_SIZE; i++) {
    const roll = r.weighted([35, 20, 45])
    shelf.push(roll === 0 ? { kind: 'herb' } : roll === 1 ? { kind: 'potion' } : { kind: 'gear', item: rollItem(r, power + 1) })
  }
  return shelf
}

// what Kaneed would buy: what its gold covers, and no remedy while its bar is full
export function affordable(shelf: readonly Ware[], gold: number, lv: number, hpFull: boolean): number[] {
  return shelf.flatMap((w, i) => (priceOf(w, lv) <= gold && !(hpFull && w.kind !== 'gear') ? [i] : []))
}
