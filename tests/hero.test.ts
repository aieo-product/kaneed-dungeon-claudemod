import { describe, expect, test } from 'bun:test'
import { rng } from '../hooks/game/rng.ts'
import { equip, gainXp, heal, newHero, stats, xpNeeded } from '../hooks/game/hero.ts'
import { bonus, isWizardItem, itemName, rollItem, SLOTS, TIER_NAMES, WIZARD_ITEMS, type Item } from '../hooks/game/items.ts'
import { testEvent } from '../hooks/game/detect.ts'

describe('items', () => {
  test('five slots, five tiers each, one wizardly pattern per slot', () => {
    expect(SLOTS.length).toBe(5)
    for (const slot of SLOTS) {
      expect(TIER_NAMES[slot].length).toBe(5)
      expect(new Set(TIER_NAMES[slot]).size).toBe(5)
      const wizard: Item = { slot, tier: WIZARD_ITEMS[slot], rarity: 1 }
      expect(isWizardItem(wizard)).toBe(true)
      expect(itemName(wizard)).toMatch(/魔|賢者/)
      expect(SLOTS.filter(s => isWizardItem({ slot: s, tier: WIZARD_ITEMS[slot], rarity: 1 })).length).toBeGreaterThanOrEqual(1)
    }
  })
  test('rarity changes the numbers, not the name', () => {
    const common: Item = { slot: 'sword', tier: 3, rarity: 1 }
    const legend: Item = { slot: 'sword', tier: 3, rarity: 5 }
    expect(itemName(common)).toBe(itemName(legend))
    expect(bonus(legend).atk).toBeGreaterThan(bonus(common).atk)
  })
  test('rolls stay in range and climb with power', () => {
    const r = rng(11)
    const low = Array.from({ length: 500 }, () => rollItem(r, 2))
    const high = Array.from({ length: 500 }, () => rollItem(r, 40))
    for (const i of [...low, ...high]) {
      expect(i.tier).toBeGreaterThanOrEqual(1)
      expect(i.tier).toBeLessThanOrEqual(5)
      expect(i.rarity).toBeGreaterThanOrEqual(1)
      expect(i.rarity).toBeLessThanOrEqual(5)
    }
    const avg = (xs: Item[]) => xs.reduce((a, i) => a + i.tier, 0) / xs.length
    expect(avg(high)).toBeGreaterThan(avg(low))
    expect(high.some(i => i.rarity === 5)).toBe(true)
  })
})

describe('hero', () => {
  test('starts at full hp and a level heals half the bar', () => {
    const h = newHero(1, 0)
    expect(h.hp).toBe(stats(h).maxHp)
    const hurt = { ...h, hp: 3 }
    const { hero, levels } = gainXp(hurt, xpNeeded(1))
    expect(levels).toBe(1)
    expect(hero.lv).toBe(2)
    expect(hero.hp).toBe(3 + Math.round(stats(hero).maxHp * 0.5))
    expect(hero.hp).toBeLessThan(stats(hero).maxHp)
  })
  test('levels are unbounded and cost more each time', () => {
    const { hero } = gainXp(newHero(1, 0), 10_000_000)
    expect(hero.lv).toBeGreaterThan(100)
    expect(xpNeeded(50)).toBeGreaterThan(xpNeeded(10))
  })
  test('a test heals a share and never past the maximum', () => {
    const h = { ...newHero(1, 0), hp: 10 }
    const { hero, healed } = heal(h, 0.35)
    expect(healed).toBe(Math.round(stats(h).maxHp * 0.35))
    expect(heal(hero, 5).hero.hp).toBe(stats(hero).maxHp)
  })
  test('a found item always replaces the worn one, even a worse one', () => {
    const good: Item = { slot: 'sword', tier: 5, rarity: 5 }
    const bad: Item = { slot: 'sword', tier: 1, rarity: 1 }
    const first = equip(newHero(1, 0), good)
    expect(first.better).toBe(true)
    expect(first.hero.equipment.sword).toEqual(good)
    const second = equip(first.hero, bad)
    expect(second.better).toBe(false)
    expect(second.hero.equipment.sword).toEqual(bad)
    expect(stats(second.hero).atk).toBeLessThan(stats(first.hero).atk)
  })
  test('a hat that adds hit points lifts hp; losing it caps hp', () => {
    const big: Item = { slot: 'hat', tier: 5, rarity: 5 }
    const small: Item = { slot: 'hat', tier: 1, rarity: 1 }
    const h = newHero(1, 0)
    const withBig = equip(h, big).hero
    expect(withBig.hp).toBe(stats(withBig).maxHp)
    const withSmall = equip(withBig, small).hero
    expect(withSmall.hp).toBe(stats(withSmall).maxHp)
    expect(withSmall.hp).toBeGreaterThan(0)
  })
})

describe('detect', () => {
  test('recognises test runners and their outcome', () => {
    expect(testEvent('Bash', 'bun test', true)).toBe('pass')
    expect(testEvent('Bash', 'npm run test -- --watch=false', false)).toBe('fail')
    expect(testEvent('Bash', 'pytest tests/', true)).toBe('pass')
    expect(testEvent('Bash', 'git status', true)).toBeUndefined()
    expect(testEvent('Edit', undefined, true)).toBeUndefined()
    expect(testEvent('Bash', 'bun test', undefined)).toBeUndefined()
  })
})
