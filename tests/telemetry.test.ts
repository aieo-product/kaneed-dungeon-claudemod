import { describe, expect, test } from 'bun:test'
import { cellWidth, compact, duration, hbar, padCells, resample, spark } from '../hooks/game/charts.ts'
import { newHero, stats } from '../hooks/game/hero.ts'
import { countEvent, countTool, dash, MINUTES_KEEP, newTelemetry, recordContext, recordHero, recordTurn, SAMPLES_KEEP, toolLabel } from '../hooks/game/telemetry.ts'

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite })

describe('charts', () => {
  test('sparklines scale to the largest value and pad to width', () => {
    expect(spark([0, 4, 8], 3)).toBe('▁▅█')
    expect(spark([1, 2], 5)).toBe('▅█   ')
    expect(spark([], 3)).toBe('   ')
    expect(spark([5, 5, 5], 3, { min: 5 })).toBe('▁▁▁')
    expect(spark([0.5], 1, { min: 0, max: 1 })).toBe('▅')
  })
  test('a long series keeps its tail, or is bucketed by mean or sum', () => {
    expect(resample([1, 2, 3, 4, 5, 6], 3)).toEqual([4, 5, 6])
    expect(resample([1, 3, 5, 7], 2, 'mean')).toEqual([2, 6])
    expect(resample([1, 3, 5, 7], 2, 'sum')).toEqual([4, 12])
    expect(spark(Array.from({ length: 100 }, (_, i) => i), 10, { mode: 'mean' })).toHaveLength(10)
  })
  test('bars are exactly as wide as asked, with a sliver for any non-zero value', () => {
    expect(hbar(10, 10, 4)).toBe('████')
    expect(hbar(5, 10, 4)).toBe('██  ')
    expect(hbar(1, 1000, 4)).toBe('▏   ')
    expect(hbar(0, 10, 4)).toBe('    ')
    for (let v = 0; v <= 10; v++) expect(cellWidth(hbar(v, 10, 7))).toBe(7)
  })
  test('Japanese labels count two cells a character', () => {
    expect(cellWidth('出力')).toBe(4)
    expect(padCells('出力', 8)).toBe('出力    ')
    expect(cellWidth(padCells('キャッシュ読み込み', 8))).toBe(8)
  })
  test('numbers and durations read short', () => {
    expect(compact(950)).toBe('950')
    expect(compact(1234)).toBe('1.2k')
    expect(compact(34_567)).toBe('35k')
    expect(compact(1_500_000)).toBe('1.5M')
    expect(duration(45_000)).toBe('45秒')
    expect(duration(12 * 60_000)).toBe('12分')
    expect(duration(65 * 60_000)).toBe('1時間05分')
  })
})

describe('telemetry', () => {
  test('events, tools and the per-minute series', () => {
    const t = newTelemetry(0)
    countEvent(t, 'ターン開始', 1000)
    countTool(t, 'Bash', 2000)
    countTool(t, 'Bash', 61_000)
    countTool(t, 'mcp__plugin_claude-mem_mcp-search__search', 125_000)
    expect(t.events).toEqual({ ターン開始: 1, ツール: 3 })
    expect(t.tools).toEqual({ Bash: 2, 'mcp-search:search': 1 })
    expect(t.perMinute).toEqual([2, 1, 1])
    expect(toolLabel('mcp__parts-manager__add_item')).toBe('parts-manager:add_item')
  })
  test('the per-minute series keeps a bounded window', () => {
    const t = newTelemetry(0)
    for (let m = 0; m < MINUTES_KEEP + 20; m++) countEvent(t, 'ターン開始', m * 60_000)
    expect(t.perMinute.length).toBe(MINUTES_KEEP)
    expect(t.minuteBase).toBe(20)
    countEvent(t, 'ターン開始', (MINUTES_KEEP + 19) * 60_000 + 5)
    expect(t.perMinute[t.perMinute.length - 1]).toBe(2)
  })
  test('turns add up their tokens; subagents are counted apart', () => {
    const t = newTelemetry(0)
    recordTurn(t, usage(100, 50, 1000, 10), 3000, undefined, 1)
    recordTurn(t, usage(10, 5), 1000, 'agent-1', 2)
    recordTurn(t, usage(10, 5), 1000, 'agent-1', 3)
    recordTurn(t, undefined, 500, undefined, 4)
    expect(t.totals).toEqual({ input: 120, output: 60, cacheRead: 1000, cacheWrite: 10 })
    expect(t.mainTurns).toBe(2)
    expect(t.agentTurns).toBe(2)
    expect(t.turns.length).toBe(3)
    expect(t.events).toEqual({ ターン完了: 2, サブ完了: 2 })
    expect(dash(t).agentCount).toBe(1)
    recordContext(t, { context: { tokens: 45_000, window: 200_000, percent: 22.5 }, cost: { usd: 0.42 } })
    recordContext(t, { context: { window: 200_000 } })
    expect(t.context).toEqual({ usd: 0.42, percent: 22.5, tokens: 45_000, window: 200_000 })
  })
  test("kills and steps add up across a death; samples thin out when full", () => {
    const t = newTelemetry(0)
    const hero = newHero(1, 0)
    const save = (at: number, log: string[] = [], died = false, levels = 0) => recordHero(t, { hero: { ...hero }, floor: hero.floor, maxHp: stats(hero).maxHp, log, died, levels }, at)
    save(0)
    hero.kills = 3
    hero.steps = 40
    save(10_000, ['スライム が落とした 革のブーツ［レア］ を手に入れて身につけた'], false, 1)
    // the run ends and the next starts from nothing
    Object.assign(hero, { run: 2, kills: 1, steps: 5 })
    save(20_000, [], true)
    expect(t.kills).toBe(4)
    expect(t.steps).toBe(45)
    expect(t.deaths).toBe(1)
    expect(t.levels).toBe(1)
    expect(t.items).toBe(1)
    expect(t.samples.map(s => s.kills)).toEqual([0, 3, 4])

    for (let i = 0; i < SAMPLES_KEEP * 2; i++) save(30_000 + i * 60_000)
    expect(t.samples.length).toBeLessThanOrEqual(SAMPLES_KEEP)
    expect(t.samples.length).toBeGreaterThan(SAMPLES_KEEP / 4)
  })
  test('saves within one interval update the last sample instead of adding one', () => {
    const t = newTelemetry(0)
    const hero = newHero(1, 0)
    const save = (at: number) => recordHero(t, { hero: { ...hero }, floor: 1, maxHp: 50, log: [], died: false, levels: 0 }, at)
    save(0)
    save(1000)
    hero.hp = 20
    save(2000)
    expect(t.samples.length).toBe(2)
    expect(t.samples[1].hp).toBe(20)
    expect(t.samples[1].at).toBe(1000)
  })
  test('the dashboard snapshot is detached: freezing it leaves the telemetry writable', () => {
    const t = newTelemetry(0)
    countTool(t, 'Bash', 0)
    recordTurn(t, usage(1, 1), 10, undefined, 0)
    recordHero(t, { hero: newHero(1, 0), floor: 1, maxHp: 50, log: [], died: false, levels: 0 }, 0)
    const deepFreeze = (v: unknown): void => {
      if (typeof v !== 'object' || v === null) return
      Object.freeze(v)
      for (const x of Object.values(v)) deepFreeze(x)
    }
    deepFreeze(dash(t))
    expect(() => {
      countTool(t, 'Bash', 1)
      recordTurn(t, usage(1, 1), 10, undefined, 1)
      recordHero(t, { hero: newHero(1, 0), floor: 1, maxHp: 50, log: [], died: false, levels: 0 }, 60_000)
      recordContext(t, { cost: { usd: 1 } })
    }).not.toThrow()
    expect(t.tools.Bash).toBe(2)
  })
})
