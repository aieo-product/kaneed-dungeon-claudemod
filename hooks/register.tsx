/* @jsx h */
import type { EngineInterface, Register } from 'claude-code'
import { testEvent } from './game/detect.ts'
import { isHero, type Hero } from './game/hero.ts'
import type { RunSummary } from './game/sim.ts'
import { applySetting, bandRows, DEFAULTS, readSettings, type Settings } from './game/settings.ts'
import { countEvent, countTool, dash, isTally, newTelemetry, recordAgents, recordContext, recordHero, recordPrompt, recordTurn, type Tally } from './game/telemetry.ts'
import { CHECK_EVERY_MS, isNewer, MANIFEST_URL, versionIn } from './game/update.ts'
import { extractFromMessage, extractLinks, mergeLinks, normalizeUrl, parseHashRefs, type Link, type LinkRow } from './links/extract.ts'
import { githubSummary, hostSummary, htmlTitle, isFetchable } from './links/summary.ts'
import { findPaths, linkify, openCommands, pathOfFileUrl, resolvePath } from './links/linkify.ts'

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
//
// And the 会話リンク tab: the links, issues and PRs the conversation mentioned (./links/tray.ts),
// opened in the browser when the board posts a pressed row back here.

type View = 'game' | 'dash' | 'status' | 'log' | 'settings' | 'links'
type Choice = { type: 'settings'; settings: unknown }
type Open = { type: 'open'; url: string }
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
const isOpen = (v: unknown): v is Open => typeof v === 'object' && v !== null && (v as Open).type === 'open' && typeof (v as Open).url === 'string'

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

// ---- the 会話リンク tab: the links this session's conversation mentioned, newest first ----
// The list lives in memory and is rebuilt from the transcript at session.start, so a resumed session
// finds its links again. Summaries come from `gh api` for GitHub issues and PRs and from the page's
// <title> for anything else, and only while the tab is open; they are cached in $.store by URL so a
// link is not fetched twice. The extraction and the summaries (./links/) are ported from linktray.

type Cached = { summary: string; kind: Link['kind'] }

const RESCAN_TAIL = 20
const FETCH_AT_ONCE = 3
const CACHE_KEEP = 500

let links: Link[] = []
let linkScanned = 0
let defaultRepo: { owner: string; repo: string } | undefined
let linkCache: Record<string, Cached> = {}
const linkFetching = new Set<string>()
// the linkTitles option: whether a page other than GitHub's is asked for its <title>
let linkTitles = true

const linkLog = ($: EngineInterface, text: string) => $.ui.log(`kaneed-dungeon: links: ${text}`)
const isCache = (v: unknown): v is Record<string, Cached> => typeof v === 'object' && v !== null && !Array.isArray(v)

function applyCache(list: Link[]): Link[] {
  return list.map(link => {
    if (link.summary) return link
    const hit = linkCache[normalizeUrl(link.url)]
    return hit ? { ...link, summary: hit.summary, kind: hit.kind } : link
  })
}

async function remember($: EngineInterface, key: string, entry: Cached) {
  linkCache[key] = entry
  const keys = Object.keys(linkCache)
  if (keys.length > CACHE_KEEP) for (const k of keys.slice(0, keys.length - CACHE_KEEP)) delete linkCache[k]
  await $.store.set('linkSummaries', linkCache).catch(err => linkLog($, `store write failed: ${err}`))
}

// The origin of the session's own repo, so a bare `#12` in the conversation resolves to an issue there.
async function readDefaultRepo($: EngineInterface) {
  const { exitCode, stdout } = await $.process.run(['git', 'remote', 'get-url', 'origin'], { timeoutMs: 5000 }).catch(() => ({ exitCode: 1, stdout: '' }))
  if (exitCode !== 0) return
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\s*$/.exec(stdout)
  if (m) defaultRepo = { owner: m[1]!, repo: m[2]! }
}

// Reads the transcript from message `from` on, oldest first, so the newest mention ends on top.
async function scanLinks($: EngineInterface, from: number) {
  const messages = await $.session.messages().catch(err => { linkLog($, `session.messages failed: ${err}`); return [] })
  const now = await $.clock.now()
  const start = Math.max(0, Math.min(from, messages.length))
  let changed = false
  for (let i = start; i < messages.length; i++) {
    const found = extractFromMessage(messages[i]!, now - (messages.length - i), defaultRepo)
    if (found.length === 0) continue
    links = mergeLinks(links, found)
    changed = true
  }
  linkScanned = messages.length
  if (changed) links = applyCache(links)
}

/** At session.start: the cached summaries, the session's repo, and every link the transcript already holds. */
async function startLinks($: EngineInterface) {
  const stored = await $.store.get('linkSummaries').catch(err => { linkLog($, `store read failed: ${err}`); return undefined })
  linkCache = isCache(stored) ? stored : {}
  await readDefaultRepo($)
  await scanLinks($, 0)
}

/** A prompt as it is sent: its links show before the model has read it. */
function noteLinks(text: string, seenAt: number) {
  const found = [...extractLinks(text, seenAt), ...parseHashRefs(text, seenAt, defaultRepo)]
  if (found.length) links = applyCache(mergeLinks(links, found))
}

/** After a main turn: the last messages again, where the replies and the tool results landed. */
const rescanLinks = ($: EngineInterface) => scanLinks($, Math.max(0, linkScanned - RESCAN_TAIL))

async function summarizeLink($: EngineInterface, link: Link, fetchTitles: boolean): Promise<Cached | undefined> {
  if (link.github) {
    const { owner, repo, number } = link.github
    const { exitCode, stdout, stderr } = await $.process.run(['gh', 'api', `repos/${owner}/${repo}/issues/${number}`], { timeoutMs: 15000 })
    if (exitCode !== 0) {
      linkLog($, `gh api ${owner}/${repo}#${number} failed: ${stderr.trim().split('\n')[0] ?? exitCode}`)
      return { summary: link.label ?? `${owner}/${repo}#${number}`, kind: link.kind }
    }
    const parsed = githubSummary(JSON.parse(stdout))
    return parsed ? { summary: parsed.text, kind: parsed.kind } : undefined
  }
  if (fetchTitles && isFetchable(link.url)) {
    const answer = await $.http.fetch(link.url, { headers: { accept: 'text/html' } })
    const title = answer.ok ? htmlTitle(answer.text.slice(0, 200_000)) : undefined
    if (title) return { summary: title, kind: 'link' }
  }
  return { summary: link.label ?? hostSummary(link.url), kind: 'link' }
}

/** Fetches the summaries still missing, a few at a time, redrawing as each lands. Call it only while the tab is open. */
async function fillLinks($: EngineInterface, fetchTitles: boolean) {
  const queue = links.filter(link => !link.summary && !linkFetching.has(normalizeUrl(link.url)))
  if (queue.length === 0) return
  const worker = async () => {
    for (let link = queue.shift(); link; link = queue.shift()) {
      const key = normalizeUrl(link.url)
      linkFetching.add(key)
      try {
        const entry = await summarizeLink($, link, fetchTitles)
        if (entry) {
          await remember($, key, entry)
          links = links.map(l => (normalizeUrl(l.url) === key ? { ...l, summary: entry.summary, kind: entry.kind } : l))
          $.ui.invalidate('ui.render')
        }
      } catch (err) {
        linkLog($, `summary of ${link.url} failed: ${err}`)
      } finally {
        linkFetching.delete(key)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(FETCH_AT_ONCE, queue.length) }, worker))
}

/** The rows the board draws. */
const linkRows = (): LinkRow[] => links.map(link => ({ url: link.url, text: link.summary ?? link.label ?? hostSummary(link.url), kind: link.kind }))

/**
 * Runs `argv`, then `fallback` when the first exits non-zero or cannot start at all (no `open` on
 * Linux), and toasts the outcome under `shown`.
 */
async function runOpener($: EngineInterface, argv: string[], fallback: string[], shown: string) {
  const run = (cmd: string[]) => $.process.run(cmd, { timeoutMs: 10000 })
  let result = await run(argv).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  if (result.exitCode !== 0) result = await run(fallback).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  if (result.exitCode === 0) $.ui.toast(`開きました: ${shown}`)
  else $.ui.toast(`開けませんでした: ${shown} (${result.stderr.trim().split('\n')[0] || `exit ${result.exitCode}`})`)
}

/** Opens a listed link in the browser; a URL the list does not hold is refused. */
async function openLink($: EngineInterface, url: string) {
  if (!links.some(link => link.url === url)) return
  await runOpener($, ['open', url], ['xdg-open', url], url)
}

// ---- links in the transcript: a click on a path, an issue word or a URL in a reply opens it ----
// The reply is drawn again as Markdown with its paths and `#12` words made links; a path is made one
// only when it exists. The new `Markdown` `onLinkPress` hands the click here instead of the terminal:
// a directory opens in Finder, a file in its app, a URL in the browser.

let cwd = ''
let home: string | undefined
// absolute path → whether it exists; dropped whenever a tool may have changed the files
const exists = new Map<string, boolean>()

/** After a tool ran or a turn ended: files may have come or gone, and `/cd` may have moved the session. */
async function refreshPaths($: EngineInterface) {
  exists.clear()
  cwd = await $.session.cwd().catch(() => cwd)
}
const STAT_PER_DRAW = 40

async function knownPaths($: EngineInterface, text: string): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const ask: Promise<void>[] = []
  for (const written of findPaths(text)) {
    const abs = resolvePath(written, cwd, home)
    if (!abs) continue
    const known = exists.get(abs)
    if (known === true) found.set(written, abs)
    else if (known === undefined && ask.length < STAT_PER_DRAW) {
      ask.push($.fs.stat(abs).then(() => true, () => false).then(ok => {
        exists.set(abs, ok)
        if (ok) found.set(written, abs)
      }))
    }
  }
  await Promise.all(ask)
  return found
}

/**
 * Opens a pressed link: a plain directory in Finder, a file or an app bundle only revealed there (a
 * click must not run a script or an app the reply named), an http(s) URL in the browser.
 */
async function openPressed($: EngineInterface, href: string) {
  const path = pathOfFileUrl(href)
  let argv: string[]
  let fallback: string[]
  let shown: string
  if (path) {
    // judged by where it lands: a link named `docs` may lead to an app
    const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
    if (!stat) {
      $.ui.toast(`見つかりません: ${path}`)
      return
    }
    const plan = openCommands(stat.realPath ?? path, stat.realPath ? stat.kind : 'other')
    argv = plan.argv
    fallback = plan.fallback
    shown = plan.revealed ? `${path}（Finder で表示）` : path
  } else if (/^https?:\/\//.test(href)) {
    argv = ['open', href]
    fallback = ['xdg-open', href]
    shown = href
  } else return
  await runOpener($, argv, fallback, shown)
}

// summaries cost a `gh api` or a page fetch each: asked for only while the tab is open, not awaited
function fillIfOpen($: EngineInterface) {
  if (view === 'links') void fillLinks($, linkTitles).catch(err => $.ui.log(`kaneed-dungeon: link summaries failed: ${err}`))
}

export const register: Register = (on, options) => {
  linkTitles = options.linkTitles !== false

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
    await startLinks($)
    cwd = await $.session.cwd().catch(() => '')
    home = (await $.env.get('HOME').catch(() => undefined)) || undefined
    ready = true
    $.ui.invalidate('ui.render')
    // not awaited: the session starts while the check is in flight
    if (options.updateCheck !== false) void checkUpdate($).catch(err => $.ui.log(`kaneed-dungeon: update check failed: ${err}`))
    await $.command.register({
      name: 'kaneed',
      description: 'カニード のダンジョン探索: ゲーム画面 / dash / status / log / links / hide / show (kaneed-dungeon)',
      argumentHint: '[dash | status | log | links | settings | set <項目> <値> | hide | show]',
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
    else if (arg === 'links' || arg === 'link') {
      view = 'links'
      fillIfOpen($)
    }
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
    await refreshPaths($)
    recordTurn(tele, { usage: e.usage, ms: e.durationMs, agentId: e.agentId, turnId: e.turnId, reason: e.reason }, await $.clock.now())
    // a subagent's turn ending is not the main turn ending
    if (e.agentId === undefined) {
      working = false
      // the ledger is read after the turn is recorded, so its rise prices that turn
      await refreshUsage($, view === 'dash')
      await rescanLinks($)
      fillIfOpen($)
    }
    $.ui.invalidate('ui.render')
    return r
  })

  // counted for the dashboard only: each passes straight on
  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    countEvent(tele, 'プロンプト', now)
    // a URL typed into the prompt is listed at once, before the model has read it
    noteLinks(e.text, now)
    if (view === 'links') {
      $.ui.invalidate('ui.render')
      fillIfOpen($)
    }
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
    if (!('isReadOnly' in r && r.isReadOnly)) await refreshPaths($)
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
    if (isOpen(e.data)) {
      await openLink($, e.data.url)
      return { props: props() }
    }
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

  const props = () => ({ view, working, seed, saved: hero, run, floorNum, heals, fails, settings, room, history: history.slice(-40), hall: hall.slice(-8), ...(view === 'dash' ? { dash: dash(tele) } : {}), ...(view === 'links' ? { links: linkRows() } : {}) })
  // (a Client's props are plain data: a key holding undefined is refused, so the dashboard's and the links are left out)

  // a reply in the transcript, its paths and issue words made links a click opens
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!ready || e.surface !== 'terminal' || e.props.isSummary) return next(e)
    const paths = await knownPaths($, e.props.text)
    const text = linkify(e.props.text, { paths, defaultRepo })
    if (text === e.props.text && !/https?:\/\//.test(text)) return next(e)
    const { Box, Markdown, Text } = await $.ui.resolve(e)
    // a tree of our own loses the engine's bullet, so the reply's first block draws it here
    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}><Text>{e.props.isFirstOfReply ? '⏺' : ' '}</Text></Box>
        <Box flexGrow={1} flexShrink={1}>
          <Markdown key="kaneed:reply" text={text} onLinkPress={link => void openPressed($, link.href)} />
        </Box>
      </Box>
    )
  })

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
      fillIfOpen($)
      $.ui.invalidate('ui.render')
    }
    const close = () => {
      visible = false
      $.ui.invalidate('ui.render')
    }
    // the open tab at full strength, the rest dim: the button's own [ ] is the only bracket
    const tab = (v: View, label: string) => <Button key={`kaneed:${v}`} label={label} dimColor={view !== v} onPress={pick(v)} />
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          {tab('game', 'Game')}
          {tab('dash', 'Dash')}
          {tab('status', 'Status')}
          {tab('log', 'Log')}
          {tab('links', 'Links')}
          {tab('settings', 'Settings')}
          <Button key="kaneed:close" label="Close" dimColor onPress={close} />
          <Text dimColor wrap="truncate-end">{e.props.isWorking ? ' カニード は探索中' : ' Claude の応答待ち: カニード は休憩中'}</Text>
        </Box>
        <Client key="kaneed:board" module="./boards/dungeon.tsx" width={cols} height={rows} props={props()} />
        {await next(e)}
      </Box>
    )
  })
}
