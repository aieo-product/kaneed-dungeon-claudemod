import { describe, expect, test } from 'bun:test'
import { rebuildFloor, startRun, step, takeFresh, testFailed, testPassed, type State } from '../hooks/game/sim.ts'
import { stats } from '../hooks/game/hero.ts'
import { passable } from '../hooks/game/map.ts'

const run = (s: State, ticks: number) => {
  for (let i = 0; i < ticks; i++) step(s)
  return s
}

describe('sim', () => {
  test('a run starts on a floor with enemies and a first log line', () => {
    const s = startRun(1, 1, 0)
    expect(s.enemies.length).toBeGreaterThan(5)
    expect(s.hero.lv).toBe(1)
    expect(s.log[0]).toContain('冒険 #1')
    expect(passable(s.floor, s.pos.x, s.pos.y)).toBe(true)
  })

  test('Kaneed walks, fights and stays on passable ground for thousands of ticks', () => {
    const s = startRun(2, 1, 0)
    for (let i = 0; i < 5000; i++) {
      step(s)
      expect(passable(s.floor, s.pos.x, s.pos.y)).toBe(true)
      for (const e of s.enemies) expect(e.x === s.pos.x && e.y === s.pos.y).toBe(false)
    }
    expect(s.hero.steps + s.hero.kills).toBeGreaterThan(200)
  })

  test('without heals Kaneed dies, and wakes up at level 1 on a new run', () => {
    const s = startRun(3, 1, 0)
    let died = false
    for (let i = 0; i < 20000 && !died; i++) {
      step(s)
      if (s.phase === 'dead') died = true
    }
    expect(died).toBe(true)
    expect(s.lastRun?.run).toBe(1)
    expect(s.hero.hp).toBe(0)
    run(s, 10)
    expect(s.phase).not.toBe('dead')
    expect(s.hero.run).toBe(2)
    expect(s.hero.lv).toBe(1)
    expect(s.floorNum).toBe(1)
  })

  test('the fights are close: a run lasts a while but rarely past a few levels unaided', () => {
    const levels: number[] = []
    const ticksAlive: number[] = []
    for (let seed = 10; seed < 30; seed++) {
      const s = startRun(seed, 1, 0)
      let t = 0
      while (s.phase !== 'dead' && t < 30000) { step(s); t++ }
      levels.push(s.hero.lv)
      ticksAlive.push(t)
    }
    const avgLv = levels.reduce((a, b) => a + b) / levels.length
    const avgTicks = ticksAlive.reduce((a, b) => a + b) / ticksAlive.length
    // at two ticks a second: alive for minutes, not seconds, and not for the whole afternoon
    expect(avgTicks).toBeGreaterThan(240)
    expect(avgTicks).toBeLessThan(12000)
    expect(avgLv).toBeGreaterThanOrEqual(2)
    expect(avgLv).toBeLessThan(15)
  })

  test('a passing test heals; a failing one only logs', () => {
    const s = startRun(4, 1, 0)
    s.hero = { ...s.hero, hp: 5 }
    testFailed(s)
    expect(s.hero.hp).toBe(5)
    testPassed(s)
    expect(s.hero.hp).toBe(5 + Math.round(stats(s.hero).maxHp * 0.35))
    const fresh = takeFresh(s)
    expect(fresh.some(l => l.includes('テスト失敗'))).toBe(true)
    expect(fresh.some(l => l.includes('テスト成功'))).toBe(true)
    expect(takeFresh(s)).toEqual([])
  })

  test('a compaction rebuilds the floor and keeps Kaneed', () => {
    const s = startRun(5, 1, 0)
    run(s, 300)
    const before = { lv: s.hero.lv, kills: s.hero.kills, floor: s.floorNum, tiles: Array.from(s.floor.tiles) }
    rebuildFloor(s, 999)
    expect(s.hero.lv).toBe(before.lv)
    expect(s.hero.kills).toBe(before.kills)
    expect(s.floorNum).toBe(before.floor)
    expect(Array.from(s.floor.tiles)).not.toEqual(before.tiles)
    expect(s.pos).toEqual(s.floor.entrance)
    expect(s.log[s.log.length - 1]).toContain('組み替わった')
  })

  test('a saved hero continues on its floor', () => {
    const first = startRun(6, 1, 0)
    run(first, 500)
    const s = startRun(7, first.hero.run, 0, first.hero, first.floorNum)
    expect(s.hero).toEqual({ ...first.hero, floor: first.floorNum })
    expect(s.floorNum).toBe(first.floorNum)
    expect(s.log[s.log.length - 1]).toContain('再開')
  })

  test('enemies are generated around the hero level', () => {
    const low = startRun(8, 1, 0)
    const strong = startRun(8, 1, 0, { ...low.hero, lv: 20 }, 1)
    const avg = (s: State) => s.enemies.reduce((a, e) => a + e.lv, 0) / s.enemies.length
    expect(avg(strong)).toBeGreaterThan(avg(low) + 10)
    expect(strong.enemies.some(e => e.boss)).toBe(true)
  })
})
