import { describe, expect, test } from 'bun:test'
import { rng } from '../hooks/game/rng.ts'
import { bfs, generateFloor, isFrontier, passable, reveal, T, tileAt } from '../hooks/game/map.ts'

describe('rng', () => {
  test('the same seed replays the same numbers', () => {
    const a = rng(42)
    const b = rng(42)
    expect(Array.from({ length: 5 }, () => a.int(100))).toEqual(Array.from({ length: 5 }, () => b.int(100)))
  })
  test('weighted picks every index and favours the heavy one', () => {
    const r = rng(7)
    const counts = [0, 0, 0]
    for (let i = 0; i < 3000; i++) counts[r.weighted([70, 25, 5])]++
    expect(counts[0]).toBeGreaterThan(counts[1])
    expect(counts[1]).toBeGreaterThan(counts[2])
    expect(counts[2]).toBeGreaterThan(0)
  })
})

describe('floor', () => {
  test('is one connected piece: the stairs and every chest are reachable from the entrance', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const f = generateFloor(rng(seed))
      expect(f.rooms.length).toBeGreaterThanOrEqual(8)
      expect(passable(f, f.entrance.x, f.entrance.y)).toBe(true)
      expect(tileAt(f, f.stairs.x, f.stairs.y)).toBe(T.STAIRS)
      expect(bfs(f, f.entrance, (x, y) => tileAt(f, x, y) === T.STAIRS)).not.toBeNull()
      let chests = 0
      for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) if (tileAt(f, x, y) === T.CHEST) {
        chests++
        expect(bfs(f, f.entrance, (px, py) => px === x && py === y)).not.toBeNull()
      }
      expect(chests).toBeGreaterThanOrEqual(3)
    }
  })
  test('is big enough for a long session', () => {
    const f = generateFloor(rng(3))
    let floorCells = 0
    for (const t of f.tiles) if (t !== T.WALL) floorCells++
    expect(floorCells).toBeGreaterThan(400)
  })
  test('the frontier is gone once everything is seen', () => {
    const f = generateFloor(rng(5))
    const explored = new Uint8Array(f.w * f.h)
    reveal(f, explored, f.entrance, 2)
    const count = () => {
      let n = 0
      for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) if (isFrontier(f, explored, x, y)) n++
      return n
    }
    const before = count()
    expect(before).toBeGreaterThan(0)
    reveal(f, explored, f.entrance, 200)
    expect(count()).toBe(0)
  })
})
