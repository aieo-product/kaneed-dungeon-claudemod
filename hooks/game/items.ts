import type { Rng } from './rng.ts'

// Five slots, five tiers each (the pattern: what the item is), five rarities each (how good a
// copy of that pattern it is). Rarity changes the numbers only, never the name or the look.

export const SLOTS = ['hat', 'eyewear', 'shield', 'sword', 'boots'] as const
export type Slot = (typeof SLOTS)[number]
export type Tier = 1 | 2 | 3 | 4 | 5
export type Rarity = 1 | 2 | 3 | 4 | 5
export type Item = { slot: Slot; tier: Tier; rarity: Rarity }

export const SLOT_LABEL: Record<Slot, string> = {
  hat: '帽子',
  eyewear: 'アイウェア',
  shield: '盾',
  sword: '剣',
  boots: '足装備',
}

// one wizardly pattern per slot sits among the five tiers (the pointed hat, the sage's monocle, the
// ward, the staff, the enchanted shoes); it is a pattern like any other, its tier sets its numbers
export const TIER_NAMES: Record<Slot, readonly [string, string, string, string, string]> = {
  hat: ['布の帽子', '革の帽子', '魔法使いのとんがり帽子', 'ミスリルの兜', '竜鱗の兜'],
  eyewear: ['丸メガネ', 'ゴーグル', '単眼鏡', '賢者のモノクル', '真実のモノクル'],
  shield: ['木の盾', '魔法障壁の護符', '鉄の盾', 'ミスリルの盾', '竜鱗の盾'],
  sword: ['木の剣', '銅の剣', '鉄の剣', '魔導師の杖', '竜殺しの剣'],
  boots: ['布の靴', '革のブーツ', '鉄のグリーブ', 'ミスリルのブーツ', '魔法使いの空飛ぶ靴'],
}
export const WIZARD_ITEMS: Record<Slot, Tier> = { hat: 3, eyewear: 4, shield: 2, sword: 4, boots: 5 }
export const isWizardItem = (i: Item) => WIZARD_ITEMS[i.slot] === i.tier

export const RARITY_NAMES = ['コモン', 'アンコモン', 'レア', 'エピック', 'レジェンド'] as const
export const RARITY_COLORS = ['white', 'green', 'blue', 'magenta', 'yellow'] as const
export const RARITY_MUL = [1, 1.25, 1.5, 1.8, 2.2] as const
const RARITY_WEIGHTS = [50, 28, 14, 6, 2] as const

export const itemName = (i: Item) => TIER_NAMES[i.slot][i.tier - 1]
export const rarityName = (i: Item) => RARITY_NAMES[i.rarity - 1]
export const rarityColor = (i: Item) => RARITY_COLORS[i.rarity - 1]
// one number to compare two items of a slot: a higher tier wins, a rarer copy of the same tier wins
export const itemScore = (i: Item) => i.tier * RARITY_MUL[i.rarity - 1]

export type Bonus = { atk: number; def: number; maxHp: number; crit: number; evade: number }
export const NO_BONUS: Bonus = { atk: 0, def: 0, maxHp: 0, crit: 0, evade: 0 }

// what a slot gives: the sword hits, the shield blocks, the hat is hit points, the eyewear finds
// weak points (critical %), the boots dodge (evade %)
export function bonus(i: Item): Bonus {
  const v = i.tier * RARITY_MUL[i.rarity - 1]
  switch (i.slot) {
    case 'sword': return { ...NO_BONUS, atk: v * 3 }
    case 'shield': return { ...NO_BONUS, def: v * 2 }
    case 'hat': return { ...NO_BONUS, maxHp: v * 8 }
    case 'eyewear': return { ...NO_BONUS, crit: v * 3 }
    case 'boots': return { ...NO_BONUS, evade: v * 3 }
  }
}

const clampTier = (t: number): Tier => Math.max(1, Math.min(5, t)) as Tier

// `power` is hero level plus floor: the tier climbs one step every seven, with a spread of one
export function rollItem(r: Rng, power: number, slot: Slot = r.pick(SLOTS)): Item {
  const base = clampTier(1 + Math.floor(power / 7))
  const shift = r.weighted([15, 60, 25])
  const tier = clampTier(base + shift - 1)
  const rarity = (r.weighted(RARITY_WEIGHTS) + 1) as Rarity
  return { slot, tier, rarity }
}
