import { describe, expect, test } from 'bun:test'
import { rng } from '../hooks/game/rng.ts'
import { bfs, generateFloor, idx, reveal, T, tileAt } from '../hooks/game/map.ts'
import { startRun, step, takeEvents, takeFresh, visitShop, type GameEvent, type State } from '../hooks/game/sim.ts'
import { stats } from '../hooks/game/hero.ts'
import { affordable, priceOf, rollShelf, SHELF_SIZE, type Ware } from '../hooks/game/shop.ts'

// stand Kaneed on a shop counter of its floor
const atShop = (seed: number, gold: number, hp?: number): State => {
  const s = startRun(seed, 1, 0)
  const f = generateFloor(rng(seed), { shop: true })
  s.floor = f
  s.explored = new Uint8Array(f.w * f.h)
  s.enemies = []
  s.pos = { ...f.shop! }
  s.hero = { ...s.hero, gold, hp: hp ?? s.hero.hp }
  return s
}
const shopEvent = (s: State) => takeEvents(s).find((e): e is Extract<GameEvent, { type: 'shop' }> => e.type === 'shop')!

describe('shop', () => {
  test('some floors keep a shop, reachable from the entrance and away from the stairs', () => {
    let shops = 0
    for (let seed = 1; seed <= 40; seed++) {
      const f = generateFloor(rng(seed))
      if (!f.shop) continue
      shops++
      expect(tileAt(f, f.shop.x, f.shop.y)).toBe(T.SHOP)
      expect(bfs(f, f.entrance, (x, y) => x === f.shop!.x && y === f.shop!.y)).not.toBeNull()
    }
    expect(shops).toBeGreaterThan(8)
    expect(shops).toBeLessThan(32)
    expect(generateFloor(rng(1), { shop: false }).shop).toBeNull()
  })

  test('the shelf always holds three wares, and prices climb with level and piece', () => {
    const r = rng(3)
    for (let i = 0; i < 50; i++) expect(rollShelf(r, 5).length).toBe(SHELF_SIZE)
    expect(priceOf({ kind: 'herb' }, 10)).toBeGreaterThan(priceOf({ kind: 'herb' }, 1))
    expect(priceOf({ kind: 'potion' }, 1)).toBeGreaterThan(priceOf({ kind: 'herb' }, 1))
    expect(priceOf({ kind: 'gear', item: { slot: 'sword', tier: 1, rarity: 1 } }, 1)).toBe(20)
  })

  test('only what the gold covers is bought, and no remedy on a full bar', () => {
    const shelf: Ware[] = [{ kind: 'herb' }, { kind: 'potion' }, { kind: 'gear', item: { slot: 'hat', tier: 1, rarity: 1 } }]
    expect(affordable(shelf, 0, 1, false)).toEqual([])
    expect(affordable(shelf, 20, 1, false)).toEqual([0, 2])
    expect(affordable(shelf, 1000, 1, true)).toEqual([2])
  })

  test('a visit buys one ware at random among the affordable, pays for it and closes the counter', () => {
    const picks = new Set<number>()
    for (let seed = 1; seed <= 30; seed++) {
      const s = atShop(seed, 100000, 5)
      const before = { ...s.hero }
      visitShop(s)
      const e = shopEvent(s)
      expect(e.shelf.length).toBe(SHELF_SIZE)
      expect(e.pick).toBeGreaterThanOrEqual(0)
      picks.add(e.pick)
      const ware = e.shelf[e.pick]
      expect(s.hero.gold).toBe(before.gold - priceOf(ware, before.lv))
      if (ware.kind === 'gear') expect(s.hero.equipment[ware.item.slot]).toEqual(ware.item)
      else expect(s.hero.hp).toBeGreaterThan(5)
      expect(tileAt(s.floor, s.pos.x, s.pos.y)).toBe(T.SHOP_CLOSED)
      expect(takeFresh(s).some(l => l.includes('購入'))).toBe(true)
    }
    expect(picks.size).toBe(SHELF_SIZE)
  })

  test('with no gold Kaneed leaves empty-handed', () => {
    const s = atShop(7, 0, 5)
    visitShop(s)
    const e = shopEvent(s)
    expect(e.pick).toBe(-1)
    expect(s.hero.hp).toBe(5)
    expect(s.hero.gold).toBe(0)
    expect(takeFresh(s).some(l => l.includes('何も買えなかった'))).toBe(true)
  })

  test('Kaneed heads for a shop it has seen and shops once', () => {
    const s = atShop(9, 100000, 5)
    const shop = s.floor.shop!
    s.pos = { ...s.floor.entrance }
    s.explored.fill(0)
    reveal(s.floor, s.explored, shop, 1)
    reveal(s.floor, s.explored, s.pos)
    let visits = 0
    for (let i = 0; i < 400; i++) {
      step(s)
      visits += takeEvents(s).filter(e => e.type === 'shop').length
    }
    expect(visits).toBe(1)
    expect(s.floor.tiles[idx(s.floor, shop.x, shop.y)]).toBe(T.SHOP_CLOSED)
    expect(s.hero.hp).toBeLessThanOrEqual(stats(s.hero).maxHp)
  })
})
