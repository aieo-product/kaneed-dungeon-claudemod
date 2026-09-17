/* @jsx h */
import type { EngineInterface, Register } from 'claude-code'
import { testEvent } from './game/detect.ts'
import { isHero, type Hero } from './game/hero.ts'
import type { RunSummary } from './game/sim.ts'
import { applySetting, bandRows, DEFAULTS, readSettings, type Settings } from './game/settings.ts'
import { countEvent, countTool, dash, isTally, newTelemetry, recordAgents, recordContext, recordHero, recordPrompt, recordTurn, type Tally } from './game/telemetry.ts'
import { CHECK_EVERY_MS, isNewer, MANIFEST_URL, versionIn } from './game/update.ts'

// The hooks module. It owns what outlives a session: Kaneed's sheet, the run number, the floor,
// the action log and the hall of past runs, all in $.store. The board (./boards/dungeon.tsx) runs
// the dungeon itself on the drawing thread and posts its state back here to be saved.
//
// Kaneed explores while a model turn is running, and rests while Claude waits for you. It heals for
// free on a level up and on a test run of Claude's that passed (seen on tool.call); besides those,
// only a shop it happens upon sells it a remedy (the board runs the visit, ./game/shop.ts).
//
// It also keeps this session's telemetry (./game/telemetry.ts) for the dashboard tab: every event
// it catches, the tokens each turn spent, and Kaneed's progress at each save. Memory only.

type View = 'game' | 'dash' | 'status' | 'log' | 'settings'
type Choice = { type: 'settings'; settings: unknown }
type Save = { type: 'save'; hero: Hero; floorNum: number; log: string[]; dead?: RunSummary | null; levels?: number; tally?: Tally }

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
let view: View = 'game'
let tele = newTelemetry(0)
let settings: Settings = DEFAULTS
// how many rows the engine last offered the band: what the height setting is measured against
let room = 0
let visible = true
let saving = false
let working = false
// the band draws once the store has been read: a board mounted before that would start a fresh
// Kaneed over the saved one, and then save it
let ready = false

const isChoice = (v: unknown): v is Choice => typeof v === 'object' && v !== null && (v as Choice).type === 'settings'

// The update notice. A third-party marketplace does not update itself unless the person turned
// auto-update on, so once a day the plugin reads the manifest on the default branch and says, in a
// toast, that a newer one is out. It is the one call that leaves the machine, and the `updateCheck`
// option turns it off. Nothing is installed: updating stays the person's to do.
async function checkUpdate($: EngineInterface) {
  const now = await $.clock.now()
  const last = Number(await $.store.get('updateCheckedAt').catch(() => 0)) || 0
  if (now - last < CHECK_EVERY_MS) return
  await $.store.set('updateCheckedAt', now).catch(() => {})
  const manifest = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).catch(() => '')
  const mine = versionIn(manifest)
  if (!mine) return
  const answer = await $.http.fetch(MANIFEST_URL)
  if (!answer.ok) return
  const latest = versionIn(answer.text)
  if (!isNewer(latest, mine)) return
  $.ui.toast(`kaneed-dungeon ${latest} が出ています（いまは ${mine}）。/plugin から更新するか、settings.json のマーケットプレイスに "autoUpdate": true を書くと次からは自動で入ります`)
}

const isSave = (v: unknown): v is Save => typeof v === 'object' && v !== null && (v as Save).type === 'save' && isHero((v as Save).hero)

// The cost, the context fill and the rate-limit windows, as the status line has them: the plain
// call is free. The dashboard also asks for the context broken down by category, which `summary`
// estimates locally (no request either; `full` would count each category by API, so it is never
// asked for). Reading it is work, so only the open dashboard asks.
async function refreshUsage($: EngineInterface, breakdown = false) {
  const usage = breakdown
    ? await $.session.usage({ breakdown: 'summary' }).catch(err => { $.ui.log(`kaneed-dungeon: session.usage failed: ${err}`); return undefined })
    : await $.session.usage().catch(err => { $.ui.log(`kaneed-dungeon: session.usage failed: ${err}`); return undefined })
  if (usage) recordContext(tele, usage, await $.clock.now())
  // the roster the session already holds: which subagent each loop was. Reading it starts nothing.
  const agents = await $.agent.list().catch(err => { $.ui.log(`kaneed-dungeon: agent.list failed: ${err}`); return [] })
  recordAgents(tele, agents)
}

export const register: Register = (on, options) => {
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
    settings = readSettings(await stored('settings'))
    const now = await $.clock.now()
    seed = now >>> 0
    tele = newTelemetry(now)
    await refreshUsage($)
    ready = true
    $.ui.invalidate('ui.render')
    // not awaited: the session starts while the check is in flight
    if (options.updateCheck !== false) void checkUpdate($).catch(err => $.ui.log(`kaneed-dungeon: update check failed: ${err}`))
    await $.command.register({
      name: 'kaneed',
      description: 'カニード のダンジョン探索: ゲーム画面 / dash / status / log / hide / show (kaneed-dungeon)',
      argumentHint: '[dash | status | log | settings | set <項目> <値> | hide | show]',
      immediate: true,
    }).catch(err => $.ui.log(`kaneed-dungeon: /kaneed not registered: ${err}`))
    return r
  })

  on('command.run', { command: 'kaneed' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    // `/kaneed set <what> <value>`: the settings screen's choices, from the keyboard
    if (arg.startsWith('set ')) {
      const result = applySetting(settings, arg.slice(4).trim().split(/\s+/))
      if (result.settings !== settings) {
        settings = result.settings
        await $.store.set('settings', settings).catch(err => $.ui.log(`kaneed-dungeon: store write failed: ${err}`))
      }
      visible = true
      view = 'settings'
      $.ui.invalidate('ui.render')
      return { text: `カニード · ${result.message}` }
    }
    if (arg === 'hide' || arg === 'stop' || arg === 'close') {
      visible = false
      $.ui.invalidate('ui.render')
      return { text: 'カニード の画面を閉じた。/kaneed で再表示（探索は止まる）' }
    }
    visible = true
    if (arg === 'settings' || arg === 'config' || arg === 'set') view = 'settings'
    else if (arg === 'status' || arg === 'st') view = 'status'
    else if (arg === 'log' || arg === 'history') view = 'log'
    else if (arg === 'dash' || arg === 'dashboard' || arg === 'stats') {
      view = 'dash'
      await refreshUsage($, true)
    } else view = 'game'
    $.ui.invalidate('ui.render')
    const lv = hero ? `Lv ${hero.lv} · HP ${hero.hp}` : 'Lv 1'
    return { text: `カニード · 冒険 #${run} · B${floorNum}F · ${lv} · 上のボタンで表示を切り替え · /kaneed hide で閉じる` }
  })

  // the band's isWorking prop changes with the turn; a redraw carries it to the board
  on('turn.start', async ($, e, next) => {
    working = true
    recordPrompt(tele, e.turnId, e.text)
    countEvent(tele, 'ターン開始', await $.clock.now())
    $.ui.invalidate('ui.render')
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    recordTurn(tele, { usage: e.usage, ms: e.durationMs, agentId: e.agentId, turnId: e.turnId, reason: e.reason }, await $.clock.now())
    // a subagent's turn ending is not the main turn ending
    if (e.agentId === undefined) {
      working = false
      // the ledger is read after the turn is recorded, so its rise prices that turn
      await refreshUsage($, view === 'dash')
    }
    $.ui.invalidate('ui.render')
    return r
  })

  // counted for the dashboard only: each passes straight on
  on('prompt.submit', async ($, e, next) => {
    countEvent(tele, 'プロンプト', await $.clock.now())
    return next(e)
  })
  on('skill.prompt', async ($, e, next) => {
    countEvent(tele, 'スキル', await $.clock.now())
    return next(e)
  })

  // a compaction rebuilds the floor: a new seed reaches the board with the next props
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    const now = await $.clock.now()
    seed = (now ^ 0x5bd1e995) >>> 0
    countEvent(tele, '圧縮', now)
    $.ui.invalidate('ui.render')
    return r
  })

  // a passing test run is the one heal Claude can give Kaneed
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    const now = await $.clock.now()
    countTool(tele, e.tool, now)
    const command = (e as { command?: unknown }).command
    const event = testEvent(e.tool, typeof command === 'string' ? command : undefined, 'deny' in r ? undefined : !r.isError)
    if (event === 'pass') heals++
    else if (event === 'fail') fails++
    if (event) countEvent(tele, event === 'pass' ? 'テスト成功' : 'テスト失敗', now)
    if (event || view === 'dash') $.ui.invalidate('ui.render')
    return r
  })

  // the board posts its state after a tick, and a pressed setting when the player changes one
  on('ui.message', async ($, e, next) => {
    if (isChoice(e.data)) {
      settings = readSettings(e.data.settings)
      await $.store.set('settings', settings).catch(err => $.ui.log(`kaneed-dungeon: store write failed: ${err}`))
      $.ui.invalidate('ui.render')
      return { props: props() }
    }
    if (!isSave(e.data)) return next(e)
    const data = e.data
    hero = data.hero
    floorNum = data.floorNum
    run = data.hero.run
    if (data.log.length) history = [...history, ...data.log].slice(-LOG_KEEP)
    if (data.dead) hall = [...hall, data.dead].slice(-HALL_KEEP)
    recordHero(tele, { hero, floor: floorNum, died: !!data.dead, levels: data.levels ?? 0, tally: isTally(data.tally) ? data.tally : undefined })
    for (const line of data.log) if (line.startsWith('ショップで')) $.ui.toast(line)
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

  const props = () => ({ view, working, seed, saved: hero, run, floorNum, heals, fails, settings, room, history: history.slice(-40), hall: hall.slice(-8), ...(view === 'dash' ? { dash: dash(tele) } : {}) })
  // (a Client's props are plain data: a key holding undefined is refused, so the dashboard's is left out)

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!ready || !visible || e.props.hasSurvey || e.surface !== 'terminal') return next(e)
    working = e.props.isWorking
    const { Box, Button, Client, Text } = await $.ui.resolve(e)
    const cols = e.props.bodyColumns ?? e.viewport?.columns ?? 80
    // as tall as the player asked for, inside what the terminal has room for
    room = e.props.maxRows
    const rows = bandRows(settings, e.props.maxRows)
    const pick = (v: View) => async () => {
      view = v
      if (v === 'dash') await refreshUsage($, true)
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
          {tab('game', 'ゲーム画面')}
          {tab('dash', 'ダッシュボード')}
          {tab('status', 'ステータス')}
          {tab('log', '履歴')}
          {tab('settings', '設定')}
          <Button key="kaneed:close" label="閉じる" onPress={close} />
          <Text dimColor>{e.props.isWorking ? ' カニード は探索中' : ' Claude の応答待ち: カニード は休憩中'}</Text>
        </Box>
        <Client key="kaneed:board" module="./boards/dungeon.tsx" width={cols} height={rows} props={props()} />
        {await next(e)}
      </Box>
    )
  })
}
