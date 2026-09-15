/* @jsx h */
import type { Register } from 'claude-code'
import { testEvent } from './game/detect.ts'
import { isHero, type Hero } from './game/hero.ts'
import type { RunSummary } from './game/sim.ts'

// The hooks module. It owns what outlives a session: Kaneed's sheet, the run number, the floor,
// the action log and the hall of past runs, all in $.store. The board (./boards/dungeon.tsx) runs
// the dungeon itself on the drawing thread and posts its state back here to be saved.
//
// Kaneed explores while a model turn is running, and rests while Claude waits for you. Heals come
// from two places only: a level up, and a test run of Claude's that passed (seen on tool.call).

type View = 'dash' | 'status' | 'log'
type Save = { type: 'save'; hero: Hero; floorNum: number; log: string[]; dead?: RunSummary | null; levels?: number }

const LOG_KEEP = 300
const HALL_KEEP = 30

let hero: Hero | null = null
let floorNum = 1
let run = 1
let history: string[] = []
let hall: RunSummary[] = []
let seed = 1
let heals = 0
let fails = 0
let view: View = 'dash'
let visible = true
let saving = false
let working = false
// the band draws once the store has been read: a board mounted before that would start a fresh
// Kaneed over the saved one, and then save it
let ready = false

const isSave = (v: unknown): v is Save => typeof v === 'object' && v !== null && (v as Save).type === 'save' && isHero((v as Save).hero)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const stored = (key: string) => $.store.get(key).catch(err => { $.ui.log(`kaneed-dungeon: store read failed: ${err}`); return undefined })
    const savedHero = await stored('hero')
    hero = isHero(savedHero) ? savedHero : null
    run = Number((await stored('run')) ?? hero?.run ?? 1) || 1
    floorNum = Number((await stored('floor')) ?? hero?.floor ?? 1) || 1
    const savedLog = await stored('log')
    history = Array.isArray(savedLog) ? savedLog.filter((l): l is string => typeof l === 'string') : []
    const savedHall = await stored('hall')
    hall = Array.isArray(savedHall) ? (savedHall as RunSummary[]) : []
    seed = (await $.clock.now()) >>> 0
    ready = true
    $.ui.invalidate('ui.render')
    await $.command.register({
      name: 'kaneed',
      description: 'カニード のダンジョン探索: ダッシュボード / status / log / hide / show (kaneed-dungeon)',
      argumentHint: '[status | log | hide | show]',
      immediate: true,
    }).catch(err => $.ui.log(`kaneed-dungeon: /kaneed not registered: ${err}`))
    return r
  })

  on('command.run', { command: 'kaneed' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'hide' || arg === 'stop' || arg === 'close') {
      visible = false
      $.ui.invalidate('ui.render')
      return { text: 'カニード の画面を閉じた。/kaneed で再表示（探索は止まる）' }
    }
    visible = true
    if (arg === 'status' || arg === 'st') view = 'status'
    else if (arg === 'log' || arg === 'history') view = 'log'
    else view = 'dash'
    $.ui.invalidate('ui.render')
    const lv = hero ? `Lv ${hero.lv} · HP ${hero.hp}` : 'Lv 1'
    return { text: `カニード · 冒険 #${run} · B${floorNum}F · ${lv} · 上のボタンで表示を切り替え · /kaneed hide で閉じる` }
  })

  // the band's isWorking prop changes with the turn; a redraw carries it to the board
  on('turn.start', async ($, e, next) => {
    working = true
    $.ui.invalidate('ui.render')
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    working = false
    $.ui.invalidate('ui.render')
    return r
  })

  // a compaction rebuilds the floor: a new seed reaches the board with the next props
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    seed = ((await $.clock.now()) ^ 0x5bd1e995) >>> 0
    $.ui.invalidate('ui.render')
    return r
  })

  // a passing test run is the one heal Claude can give Kaneed
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    const command = (e as { command?: unknown }).command
    const event = testEvent(e.tool, typeof command === 'string' ? command : undefined, 'deny' in r ? undefined : !r.isError)
    if (!event) return r
    if (event === 'pass') heals++
    else fails++
    $.ui.invalidate('ui.render')
    return r
  })

  // the board posts its state after a tick; keep what outlives the session
  on('ui.message', async ($, e, next) => {
    if (!isSave(e.data)) return next(e)
    const data = e.data
    hero = data.hero
    floorNum = data.floorNum
    run = data.hero.run
    if (data.log.length) history = [...history, ...data.log].slice(-LOG_KEEP)
    if (data.dead) hall = [...hall, data.dead].slice(-HALL_KEEP)
    if (data.levels) $.ui.toast(`カニード が Lv ${hero.lv} になった！HP ${hero.hp} まで回復`)
    if (data.dead) $.ui.toast(`カニード は ${data.dead.killedBy} に倒された… 冒険 #${data.dead.run} は Lv ${data.dead.lv}、B${data.dead.floor}F で終わった`)
    if (!saving) {
      saving = true
      const write = (key: string, value: unknown) => $.store.set(key, value).catch(err => $.ui.log(`kaneed-dungeon: store write failed: ${err}`))
      await Promise.all([write('hero', hero), write('run', run), write('floor', floorNum), write('log', history), write('hall', hall)])
      saving = false
    }
    return { props: props() }
  })

  const props = () => ({ view, working, seed, saved: hero, run, floorNum, heals, fails, history: history.slice(-40), hall: hall.slice(-8) })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!ready || !visible || e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    working = e.props.isWorking
    const { Box, Button, Client, Text } = await $.ui.resolve(e)
    const cols = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    // the stage wants every row it can get: sprites shrink to fit a short band
    const rows = Math.max(9, Math.min(22, e.props.maxRows - 1))
    const pick = (v: View) => () => {
      view = v
      $.ui.invalidate('ui.render')
    }
    const close = () => {
      visible = false
      $.ui.invalidate('ui.render')
    }
    const tab = (v: View, label: string) => <Button key={`kaneed:${v}`} label={view === v ? `[${label}]` : ` ${label} `} onPress={pick(v)} />
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          {tab('dash', 'ダッシュボード')}
          {tab('status', 'ステータス')}
          {tab('log', '履歴')}
          <Button key="kaneed:close" label="閉じる" onPress={close} />
          <Text dimColor>{e.props.isWorking ? ' カニード は探索中' : ' Claude の応答待ち: カニード は休憩中'}</Text>
        </Box>
        <Client key="kaneed:board" module="./boards/dungeon.tsx" width={cols} height={rows} props={props()} />
        {await next(e)}
      </Box>
    )
  })
}
