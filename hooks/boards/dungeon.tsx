/* @jsx h */
import type { ClientElements, ClientSurface, RenderElement } from 'claude-code'
import { KINDS } from '../game/enemies.ts'
import { stats, xpNeeded, type Hero } from '../game/hero.ts'
import { isWizardItem, itemName, rarityColor, rarityName, RARITY_COLORS, SLOT_LABEL, SLOTS, type Slot } from '../game/items.ts'
import { idx, T, tileAt } from '../game/map.ts'
import { rebuildFloor, startRun, step, takeEvents, takeFresh, testFailed, testPassed, type GameEvent, type RunSummary, type State } from '../game/sim.ts'
import { priceOf, wareName, type Ware } from '../game/shop.ts'
import { EQUIP_ANCHORS, FALLBACK_ANCHORS, HERO_ANCHORS, HERO_OFFSETS, SPRITES, type Pixels } from './sprites.ts'
import { layerOffset } from './anchors.ts'
import { cellWidth, compact, duration, hbar, padCells, spark } from '../game/charts.ts'
import { cacheHitRate, newTally, tallyEvents, tokenTotal, type Dash, type Tally } from '../game/telemetry.ts'

// The board: a surface module on the drawing thread. The dungeon is simulated in ticks of half a
// second (../game/sim.ts); this file turns each tick's events into a side-scrolling scene drawn ten
// times a second: Kaneed on the left, whatever it meets on the right, the wall and floor scrolling
// as it walks, a minimap of the real floor in the top-right corner.
//
// Drawing is a pixel buffer: one text cell is one pixel wide and two pixels tall, drawn with ▀ and
// a foreground/background pair. Sprites come from ./sprites.ts (higgsfield renders, refined with
// PixelRefiner, shrunk to a few colours). Numbers, effects and the minimap are text laid over it.
//
// Never name a local `h` in this file: every JSX tag compiles to a call of `h`.

type Props = {
  view?: 'game' | 'dash' | 'status' | 'log'
  working?: boolean
  seed?: number
  saved?: Hero | null
  run?: number
  floorNum?: number
  heals?: number
  fails?: number
  history?: string[]
  hall?: RunSummary[]
  dash?: Dash
} | undefined

const FRAME_MS = 100
const FRAMES_PER_TICK = 5
const HERO_X = 4
const SPRITE_KEYS = ['slime', 'bat', 'goblin', 'skeleton', 'orc', 'ghost', 'minotaur', 'dragon']
const HERO_COLOR = '#ff875f'

// palette of the stage itself: every value sits on the xterm-256 cube or grey ramp, so a terminal
// that rounds colours to 256 draws the same picture as one that takes them as they are
const WALL_A = '#3a3a3a'
const WALL_B = '#303030'
const MORTAR = '#1c1c1c'
const FLOOR_TOP = '#af875f'
const FLOOR = '#5f5f5f'
const FLOOR_DOT = '#875f00'

type Cell = [glyph: string, fg?: string, bg?: string, dim?: boolean, bold?: boolean]
type Float = { x: number; y: number; text: string; color: string; ttl: number; bold?: boolean }
type Burst = { x: number; y: number; ttl: number; big: boolean }
type Foe = { key: string; name: string; boss: boolean; lv: number; hp: number; maxHp: number; x: number; home: number; state: 'enter' | 'idle' | 'dying' | 'leave'; t: number }
type ShopVisit = Extract<GameEvent, { type: 'shop' }>
type Obj = { kind: 'chest' | 'stairs' | 'shop'; t: number; dx: number; shop?: ShopVisit }
type Banner = { text: string; color?: string; ttl: number; bold?: boolean }
type TickAnim = { heroHits: { dmg: number; crit: boolean }[]; foeHits: ({ dmg: number } | 'miss')[]; t: number }

type Local = {
  sim: State
  seed: number
  heals: number
  fails: number
  frame: number
  working: boolean
  scroll: number
  walk: number
  hold: number
  heroDx: number
  heroFlash: number
  heroGlow: number
  foe: Foe | null
  foeDx: number
  foeFlash: number
  floats: Float[]
  bursts: Burst[]
  obj: Obj | null
  banners: Banner[]
  anim: TickAnim | null
  // the simulation's own counts since the last save, and whose foe is on the field
  tally: Tally
  bossFoe: { boss: boolean }
  descend: number
  dead: boolean
  // frames left of the victory pose after a kill
  victory: number
}

// hand-made props: a chest (closed, open) and a stair well, in the same pixel format as the sprites
const CHEST_CLOSED: Pixels = [
  [null, '#8a5a2b', '#8a5a2b', '#8a5a2b', '#8a5a2b', '#8a5a2b', '#8a5a2b', '#8a5a2b', '#8a5a2b', '#8a5a2b', '#8a5a2b', null],
  ['#8a5a2b', '#c98a3e', '#c98a3e', '#c98a3e', '#c98a3e', '#f0d060', '#f0d060', '#c98a3e', '#c98a3e', '#c98a3e', '#c98a3e', '#8a5a2b'],
  ['#8a5a2b', '#c98a3e', '#c98a3e', '#c98a3e', '#c98a3e', '#f0d060', '#f0d060', '#c98a3e', '#c98a3e', '#c98a3e', '#c98a3e', '#8a5a2b'],
  ['#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#f0d060', '#f0d060', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b'],
  ['#8a5a2b', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#f0d060', '#3a2a10', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#8a5a2b'],
  ['#8a5a2b', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#8a5a2b'],
  ['#8a5a2b', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#8a5a2b'],
  ['#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b'],
]
const CHEST_OPEN: Pixels = [
  ['#8a5a2b', '#c98a3e', '#c98a3e', '#c98a3e', '#c98a3e', '#c98a3e', '#c98a3e', '#c98a3e', '#c98a3e', '#c98a3e', '#c98a3e', '#8a5a2b'],
  ['#8a5a2b', '#c98a3e', '#c98a3e', '#c98a3e', '#c98a3e', '#c98a3e', '#c98a3e', '#c98a3e', '#c98a3e', '#c98a3e', '#c98a3e', '#8a5a2b'],
  ['#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b'],
  [null, '#fff3a0', '#f0d060', '#fff3a0', '#f0d060', '#fff3a0', '#f0d060', '#fff3a0', '#f0d060', '#fff3a0', '#f0d060', null],
  ['#8a5a2b', '#a8702f', '#f0d060', '#f0d060', '#f0d060', '#f0d060', '#f0d060', '#f0d060', '#f0d060', '#f0d060', '#a8702f', '#8a5a2b'],
  ['#8a5a2b', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#8a5a2b'],
  ['#8a5a2b', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#a8702f', '#8a5a2b'],
  ['#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b', '#5a3a1b'],
]
const STAIRS: Pixels = (() => {
  const w = 16
  const rows: Pixels = []
  for (let y = 0; y < 10; y++) {
    const row: (string | null)[] = []
    for (let x = 0; x < w; x++) {
      const depth = Math.floor(x / 2)
      if (y < 10 - depth - 1 && y < 5) row.push(x < 2 ? '#5A4636' : '#0E0B09')
      else if (y === 10 - depth - 1 || (y >= 5 && y < 10 - depth)) row.push(y % 2 === 0 ? '#6E6560' : '#4A423E')
      else row.push('#0E0B09')
    }
    rows.push(row)
  }
  return rows
})()

// pixel art from rows of letters, one letter a colour, '.' clear
const pix = (rows: string[], pal: Record<string, string>): Pixels => rows.map(line => [...line].map(ch => pal[ch] ?? null))

// the shopkeeper: a brown hat with a red band, a moustache, an apron with a gold button
const SHOPKEEPER = pix([
  '....KKKKKKK....',
  '...KHHHHHHHK...',
  '...KHHHHHHHK...',
  '..KRRRRRRRRRK..',
  '.KHHHHHHHHHHHK.',
  '..KSSSSSSSSSK..',
  '..KSEESSSEESK..',
  '..KSSSSNSSSSK..',
  '..KSMMMMMMMSK..',
  '...KSSMMMSSK...',
  '..KBBKSSSKBBK..',
  '.KBBBAAAAABBBK.',
  '.KSKBAAAAABKSK.',
  '.KSKBAAYAABKSK.',
  '..KKBAAAAABKK..',
  '...KPPPPPPPK...',
  '...KPPKKKPPK...',
  '...KKK...KKK...',
], { K: '#1c1c1c', H: '#875f00', R: '#af0000', S: '#ffd7af', E: '#000000', N: '#d7af87', M: '#5f3700', B: '#005f87', A: '#eeeeee', Y: '#ffd700', P: '#444444' })

// the wares on the shelf, 7x6 each; equipment by its slot
const ICON_PAL = { K: '#1c1c1c', W: '#ffffff', L: '#5faf00', G: '#87d75f', D: '#875f00', R: '#d70000', Y: '#ffd700', B: '#8a8a8a', P: '#5f5fd7' }
const ICONS: Record<string, Pixels> = {
  herb: pix(['...L...', '..LGL..', '.LGLGL.', '..LGL..', '...D...', '..DDD..'], ICON_PAL),
  potion: pix(['..KKK..', '...W...', '..KRK..', '.KRRRK.', '.KRRWK.', '..KKK..'], ICON_PAL),
  sword: pix(['.....W.', '....W..', '...W...', '.YW....', '..Y....', '.Y.....'], ICON_PAL),
  shield: pix(['.KKKKK.', '.KBYBK.', '.KYYYK.', '.KBYBK.', '..KBK..', '...K...'], ICON_PAL),
  hat: pix(['...K...', '..KPK..', '..KPK..', '.KPPPK.', 'KYYYYYK', '.......'], ICON_PAL),
  eyewear: pix(['.......', 'KKK.KKK', 'KWKKKWK', 'KKK.KKK', '.......', '.......'], ICON_PAL),
  boots: pix(['.KK....', '.KB....', '.KB....', '.KBBBK.', '.KBBBBK', '.KKKKKK'], ICON_PAL),
}
const iconOf = (w: Ware) => ICONS[w.kind === 'gear' ? w.item.slot : w.kind]
const ICON_W = 7
const ICON_H = 6
const SHELF_STEP = 10
const SHELF_W = 3 * SHELF_STEP + 2
const WOOD_TOP = '#d7875f'
const WOOD = '#875f00'
const WOOD_DARK = '#5f3700'

// the visit, in frames (0.1 s each): the keeper greets, a cursor runs over the shelf and slows onto
// the ware Kaneed picks, the ware blinks, flies to Kaneed, and takes effect
const SHOP_STEPS = [8, 10, 12, 14, 16, 19, 22, 26]
const SHOP_LAND = 26
const SHOP_FLY = 32
const SHOP_GIVE = 38
const SHOP_END = 50
// where the cursor stands at frame t: it steps back from the pick so the last step lands on it
function shopCursor(v: ShopVisit, t: number): number {
  const k = SHOP_STEPS.filter(at => at <= t).length - 1
  if (k < 0) return -1
  if (t >= SHOP_LAND && v.pick < 0) return -1
  const target = Math.max(0, v.pick)
  return (((target - (SHOP_STEPS.length - 1 - k)) % 3) + 3) % 3
}

const bar = (value: number, max: number, width: number) => {
  const filled = max > 0 ? Math.round((Math.max(0, value) / max) * width) : 0
  return '█'.repeat(Math.min(width, filled)) + '░'.repeat(Math.max(0, width - filled))
}

// a full-width character (kana, kanji, ✦ and friends) takes two cells
const wide = (ch: string) => {
  const c = ch.codePointAt(0) ?? 0
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || c === 0x2726 || c === 0x2728 || c === 0x2738 || c === 0x25c6
}

// every colour the board emits lands on the xterm-256 palette, written the way Claude Code's
// renderer (chalk: level = round(v / 255 * 5)) maps it back onto exactly that entry: cube channels
// as multiples of 51, greys as themselves. A 256-colour terminal shows the palette entry, a
// truecolor one the canonical value, a hair different but the same hue.
const CUBE = [0, 95, 135, 175, 215, 255]
const snapCache = new Map<string, string>()
const hex2 = (v: number) => v.toString(16).padStart(2, '0')
function snap256(c: string): string {
  if (!c.startsWith('#') || c.length !== 7) return c
  const hit = snapCache.get(c)
  if (hit) return hit
  const [r, g, b] = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))
  // already canonical (a sprite colour, or an earlier pass): leave it, or the second pass drifts
  if ((r % 51 === 0 && g % 51 === 0 && b % 51 === 0) || (r === g && g === b && (r - 8) % 10 === 0)) {
    snapCache.set(c, c)
    return c
  }
  const level = (v: number) => CUBE.reduce((best, x, i) => (Math.abs(x - v) < Math.abs(CUBE[best] - v) ? i : best), 0)
  const lv = [level(r), level(g), level(b)]
  const cube = lv.map(i => CUBE[i])
  const avg = (r + g + b) / 3
  const gv = Math.max(8, Math.min(238, 8 + 10 * Math.round((avg - 8) / 10)))
  const dist = (p: number[]) => (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2
  const out = dist(cube) <= dist([gv, gv, gv]) ? '#' + lv.map(i => hex2(i * 51)).join('') : '#' + hex2(gv).repeat(3)
  snapCache.set(c, out)
  return out
}
// mix a colour toward another, for glow and death tints
const mix = (a: string, b: string, t: number) => {
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16))
  const pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16))
  return snap256('#' + pa.map((v, i) => hex2(Math.round(v + (pb[i] - v) * t))).join(''))
}
const gray = (c: string) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))
  const v = hex2(Math.round(0.3 * r + 0.59 * g + 0.11 * b))
  return snap256(`#${v}${v}${v}`)
}
const snapAll = (px: Pixels): Pixels => px.map(row => row.map(c => (c ? snap256(c) : null)))

// one styled span per run of cells sharing a style, folded pairwise until the row fits the budget
function row(Text: ClientElements['Text'], cells: Cell[], maxRuns = 64) {
  let runs: Cell[] = []
  for (const c of cells) {
    const last = runs[runs.length - 1]
    if (last && last[1] === c[1] && last[2] === c[2] && last[3] === c[3] && last[4] === c[4]) last[0] += c[0]
    else runs.push([c[0], c[1], c[2], c[3], c[4]])
  }
  while (runs.length > maxRuns) {
    const folded: Cell[] = []
    for (let i = 0; i < runs.length; i += 2) {
      const a = runs[i]
      const b = runs[i + 1]
      folded.push(b ? [a[0] + b[0], a[1], a[2], a[3], a[4]] : a)
    }
    runs = folded
  }
  return <Text>{runs.map(([t, fg, bg, dim, bold]) => <Text color={fg && snap256(fg)} backgroundColor={bg && snap256(bg)} dimColor={dim} bold={bold}>{t}</Text>)}</Text>
}

// the pixel canvas: W cells wide, 2*rows pixels tall
class Canvas {
  buf: (string | null)[]
  constructor(public w: number, public hpx: number) {
    this.buf = Array.from({ length: w * hpx }, () => null)
  }
  set(x: number, y: number, c: string | null) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.hpx || c === null) return
    this.buf[y * this.w + x] = c
  }
  blit(px: Pixels, x0: number, y0: number, tint?: (c: string) => string) {
    for (let y = 0; y < px.length; y++) for (let x = 0; x < px[y].length; x++) {
      const c = px[y][x]
      if (c) this.set(x0 + x, y0 + y, tint ? tint(c) : c)
    }
  }
  cells(): Cell[][] {
    const out: Cell[][] = []
    for (let r = 0; r < this.hpx / 2; r++) {
      const line: Cell[] = []
      for (let x = 0; x < this.w; x++) {
        const tp = this.buf[(2 * r) * this.w + x] ?? '#000000'
        const bp = this.buf[(2 * r + 1) * this.w + x] ?? '#000000'
        line.push(tp === bp ? [' ', undefined, tp] : ['▀', tp, bp])
      }
      out.push(line)
    }
    return out
  }
}

// text laid over the cells; a wide character takes the next cell too
function put(cells: Cell[][], x: number, y: number, text: string, fg?: string, bold?: boolean, bg?: string) {
  const line = cells[y]
  if (!line) return
  let cx = x
  for (const ch of text) {
    if (cx >= line.length) break
    if (cx >= 0) line[cx] = [ch, fg, bg ?? line[cx][2], false, bold]
    cx++
    if (wide(ch)) {
      if (cx >= 0 && cx < line.length) line[cx] = ['', fg, bg ?? line[cx][2], false, bold]
      cx++
    }
  }
}

const spriteOf = (key: string): Pixels => SPRITES[key] ?? SPRITES.slime

// The hero: frames from tools/sprites/hero/ when they exist (hero_idle_0, hero_walk_1, ...), else
// the single Kaneed figure. Equipment layers (equip_<slot>_<tier>) are laid over the body, back to
// front, shifted by the frame's offset so they follow the body's bob.
type HeroPose = 'idle' | 'walk' | 'attack' | 'hurt' | 'dead' | 'victory'
const EQUIP_ORDER: Slot[] = ['boots', 'shield', 'sword', 'hat', 'eyewear']
// the idle loop: breathe, breathe, glance at the foe's side, breathe, breathe, blink
const IDLE_LOOP = ['idle_0', 'idle_1', 'idle_0', 'idle_glance', 'idle_0', 'idle_0', 'idle_blink', 'idle_0']
function heroFrameKey(pose: HeroPose, alt: number): string {
  const name = pose === 'idle' ? IDLE_LOOP[alt % IDLE_LOOP.length]
    : pose === 'hurt' || pose === 'dead' || pose === 'victory' ? pose
    : `${pose}_${alt % 2}`
  if (SPRITES[`hero_${name}`]) return `hero_${name}`
  if (pose === 'idle' && SPRITES[`hero_idle_${alt % 2}`]) return `hero_idle_${alt % 2}`
  if (SPRITES[`hero_idle_${alt % 2}`]) return `hero_idle_${alt % 2}`
  return SPRITES.hero_idle_0 ? 'hero_idle_0' : 'kaneed'
}
function drawHero(canvas: Canvas, hero: Hero, pose: HeroPose, alt: number, x: number, y: number, maxH: number, tint?: (c: string) => string): Pixels {
  const key = heroFrameKey(pose, alt)
  const body = fit(spriteOf(key), key, maxH)
  canvas.blit(body, x, y, tint)
  // layers are drawn only when the body was not shrunk, since they share its canvas
  if (body === SPRITES[key]) {
    const frame = key.replace('hero_', '')
    // the fallback figure has its own anchor table; the hero frames share theirs
    const anchors = key === 'fallback' ? FALLBACK_ANCHORS : HERO_ANCHORS
    for (const slot of EQUIP_ORDER) {
      const item = hero.equipment[slot]
      const layerKey = item ? `equip_${slot}_${item.tier}` : ''
      const layer = layerKey ? SPRITES[layerKey] : undefined
      if (!layer) continue
      const [dx, dy] = layerOffset(frame, slot, layerKey, anchors, EQUIP_ANCHORS, HERO_OFFSETS[frame])
      canvas.blit(layer, x + dx, y + dy, tint)
    }
  }
  return body
}

// nearest-neighbour shrink so a sprite fits a short stage (never enlarges)
const fitCache = new Map<string, Pixels>()
function fit(px: Pixels, key: string, maxH: number): Pixels {
  if (px.length <= maxH) return px
  const id = `${key}:${maxH}`
  const hit = fitCache.get(id)
  if (hit) return hit
  const scale = maxH / px.length
  const w = Math.max(1, Math.round(widthOf(px) * scale))
  const out: Pixels = []
  for (let y = 0; y < maxH; y++) {
    const sy = Math.min(px.length - 1, Math.floor(y / scale))
    const line: (string | null)[] = []
    for (let x = 0; x < w; x++) line.push(px[sy][Math.min(px[sy].length - 1, Math.floor(x / scale))])
    out.push(line)
  }
  fitCache.set(id, out)
  return out
}
const widthOf = (px: Pixels) => px[0]?.length ?? 0

export default function Dungeon(props: Props, surface: ClientSurface<Local>) {
  const { Box, Text } = surface.elements
  const now = Date.now()

  if (surface.state === undefined) {
    const seed = props?.seed ?? 1
    const sim = startRun(seed, props?.run ?? props?.saved?.run ?? 1, now, props?.saved ?? null, props?.floorNum ?? 1, props?.history ?? [])
    takeEvents(sim)
    surface.setState({
      sim, seed, heals: props?.heals ?? 0, fails: props?.fails ?? 0, frame: 0, working: props?.working === true,
      scroll: 0, walk: 0, hold: 0, heroDx: 0, heroFlash: 0, heroGlow: 0, foe: null, foeDx: 0, foeFlash: 0,
      floats: [], bursts: [], obj: null, banners: [{ text: sim.log[sim.log.length - 1] ?? '', color: HERO_COLOR, ttl: 30 }], anim: null,
      tally: newTally(), bossFoe: { boss: false }, descend: 0, dead: false, victory: 0,
    })
    surface.every(FRAME_MS, () => {
      const s = surface.state
      if (!s) return
      s.frame++
      advance(s, surface.columns)
      if (s.frame % FRAMES_PER_TICK === 0 && s.hold <= 0 && (s.working || s.sim.phase === 'dead')) {
        const sim = s.sim
        const lvBefore = sim.hero.lv
        const wasDead = sim.phase === 'dead'
        step(sim, Date.now())
        const events = takeEvents(sim)
        apply(s, events, surface.columns)
        tallyEvents(s.tally, events, s.bossFoe)
        const fresh = takeFresh(sim)
        const died = !wasDead && sim.phase === 'dead' ? sim.lastRun : null
        const levels = sim.hero.lv > lvBefore ? sim.hero.lv - lvBefore : 0
        // the sheet is saved when something happened, and every few ticks anyway (steps count too)
        if (fresh.length || died || levels || sim.tick % 20 === 0) {
          surface.post({ type: 'save', hero: sim.hero, floorNum: sim.floorNum, log: fresh, dead: died, levels, tally: s.tally })
          s.tally = newTally()
        }
      }
      surface.setState({ ...s })
    })
  }

  const s = surface.state
  if (!s) return <Text dimColor>kaneed-dungeon: loading…</Text>
  const sim = s.sim
  s.working = props?.working === true

  // new props: a compaction's seed rebuilds the floor; a passing test heals; a failing one is noted
  let changed = false
  if (props?.seed !== undefined && props.seed !== s.seed) {
    rebuildFloor(sim, props.seed)
    s.seed = props.seed
    changed = true
  }
  if (props?.heals !== undefined && props.heals > s.heals) {
    for (let i = s.heals; i < props.heals; i++) testPassed(sim)
    s.heals = props.heals
    changed = true
  }
  if (props?.fails !== undefined && props.fails > s.fails) {
    for (let i = s.fails; i < props.fails; i++) testFailed(sim)
    s.fails = props.fails
    s.banners.push({ text: 'テスト失敗… カニード が不安そうにこちらを見た', color: 'yellow', ttl: 20 })
    changed = true
  }
  if (changed) {
    const events = takeEvents(sim)
    apply(s, events, surface.columns)
    tallyEvents(s.tally, events, s.bossFoe)
    const fresh = takeFresh(sim)
    if (fresh.length) {
      surface.post({ type: 'save', hero: sim.hero, floorNum: sim.floorNum, log: fresh, tally: s.tally })
      s.tally = newTally()
    }
  }

  // during a shop visit the sheet shows what Kaneed had until the ware reaches it
  const visit = s.obj?.kind === 'shop' && s.obj.shop && s.obj.t < SHOP_GIVE ? s.obj.shop : null
  const hero = visit ? { ...sim.hero, hp: visit.hp, gold: visit.gold, equipment: visit.equipment } : sim.hero
  const st = stats(hero)
  const hpRatio = st.maxHp ? hero.hp / st.maxHp : 0
  const lowHp = hpRatio <= 0.25
  const hpColor = lowHp ? 'red' : hpRatio <= 0.5 ? 'yellow' : 'green'
  const cols = Math.max(40, surface.columns)
  const rows = Math.max(8, surface.rows)

  const header = (
    <Text wrap="truncate-end">
      <Text color={HERO_COLOR} bold>{'Kaneed '}</Text>
      <Text bold>{`Lv ${hero.lv}  `}</Text>
      <Text color={hpColor}>{bar(hero.hp, st.maxHp, 16)}</Text>
      <Text color={hpColor}>{` ${hero.hp}/${st.maxHp}`}</Text>
      <Text dimColor>{' HP   '}</Text>
      <Text color="cyan" bold>{`B${sim.floorNum}F`}</Text>
      <Text>{`   ⚔ ${hero.kills}   `}</Text>
      <Text color="yellow">{`◆ ${hero.gold} G`}</Text>
      <Text dimColor>{`   冒険 #${hero.run}   XP ${hero.xp}/${xpNeeded(hero.lv)}`}</Text>
    </Text>
  )

  if (props?.view === 'status') return statusView(s, header, Box, Text)
  if (props?.view === 'log') return logView(s, props, header, rows, Box, Text)
  if (props?.view === 'dash') return dashView(s, props.dash, header, cols, rows, Box, Text)

  // ---- the stage ----
  const stageRows = rows - 2
  const canvas = new Canvas(cols, stageRows * 2)
  const chestClosed = snapAll(CHEST_CLOSED)
  const chestOpen = snapAll(CHEST_OPEN)
  const stairs = snapAll(STAIRS)
  const groundPx = canvas.hpx - 3
  // wall bricks, scrolling with Kaneed's steps; the floor with its scattered grit
  for (let y = 0; y < canvas.hpx; y++) {
    const band = Math.floor(y / 4)
    for (let x = 0; x < cols; x++) {
      if (y < groundPx) {
        const mortarRow = y % 4 === 3
        const mortarCol = (x + (band % 2) * 7 + s.scroll * 2) % 14 === 0
        canvas.set(x, y, mortarRow || mortarCol ? MORTAR : band % 2 ? WALL_A : WALL_B)
      } else if (y === groundPx) canvas.set(x, y, FLOOR_TOP)
      else canvas.set(x, y, (x + s.scroll * 2 + y * 3) % 9 === 0 ? FLOOR_DOT : y === groundPx + 1 ? '#4e4e4e' : FLOOR)
    }
  }
  // the object Kaneed found stands where a foe would
  const heroKey0 = heroFrameKey('idle', 0)
  const heroPx = fit(spriteOf(heroKey0), heroKey0, canvas.hpx - 4)
  const heroW = widthOf(heroPx)
  const frontX = HERO_X + heroW + 12
  const shopAt = s.obj?.kind === 'shop' && s.obj.shop ? drawShop(canvas, s.obj, frontX + s.obj.dx, groundPx) : null
  if (s.obj) {
    if (s.obj.kind === 'chest') canvas.blit(s.obj.t >= 6 ? chestOpen : chestClosed, frontX + s.obj.dx, groundPx - 8)
    else if (s.obj.kind === 'stairs') canvas.blit(stairs, frontX, groundPx - 10)
  }
  // the foe, bobbing in counter-phase, flashing when hit, flickering out when slain
  // the foe's three idle frames (rest, squash, stretch) loop while it stands; the lunge stretches
  // on the way in and squashes on contact; a dying foe holds its rest frame
  const foeFrame = !s.foe ? '' : s.foe.state === 'dying' ? '' : s.foeDx <= -3 ? '_1' : s.foeDx < 0 ? '_2' : ['', '_1', '', '_2'][Math.floor(s.frame / 6) % 4]
  const foeKey = s.foe ? (SPRITES[s.foe.key + foeFrame] ? s.foe.key + foeFrame : s.foe.key) : ''
  const foePx = s.foe ? fit(spriteOf(foeKey), foeKey, s.foe.boss ? canvas.hpx - 3 : canvas.hpx - 5) : null
  if (s.foe && foePx && !(s.foe.state === 'dying' && s.foe.t % 2 === 1)) {
    const bob = Math.floor(s.frame / 6 + 3) % 2
    // a hit reads as a white flash (a colour tint would muddy a green or blue foe)
    const tint = s.foeFlash > 0 ? (c: string) => (s.foeFlash % 2 ? mix(c, '#FFFFFF', 0.8) : c) : s.foe.state === 'dying' ? (c: string) => mix(c, '#FFFFFF', 0.6) : undefined
    canvas.blit(foePx, Math.round(s.foe.x) + s.foeDx, groundPx - foePx.length + bob, tint)
  }
  // Kaneed: breathing while it stands, bouncing as it walks, lunging when it strikes
  const walking = s.working && sim.phase === 'explore' && !s.dead && s.hold <= 0
  const bob = walking ? s.walk : Math.floor(s.frame / 8) % 2
  const heroTint = s.dead ? (c: string) => mix(gray(c), '#000000', 0.3)
    : s.heroFlash > 0 ? (c: string) => (s.heroFlash % 2 ? mix(c, '#FFFFFF', 0.75) : mix(c, '#FF3030', 0.6))
    : s.heroGlow > 0 && s.frame % 2 === 0 ? (c: string) => mix(c, '#FFFFFF', 0.45)
    : s.descend > 0 ? (c: string) => mix(c, '#0E0B09', Math.min(0.9, (24 - s.descend) / 24))
    : undefined
  const heroY = groundPx - heroPx.length + (s.dead ? 3 : bob)
  const pose: HeroPose = s.dead ? 'dead' : s.heroFlash > 0 ? 'hurt' : s.heroDx > 0 ? 'attack' : s.victory > 0 ? 'victory' : walking ? 'walk' : 'idle'
  // the idle loop advances every 0.8 s; walking alternates per step; the strike has two frames
  const alt = walking ? s.walk : s.heroDx > 0 ? (s.heroDx >= 3 ? 1 : 0) : Math.floor(s.frame / 8)
  drawHero(canvas, hero, pose, alt, HERO_X + s.heroDx, heroY, canvas.hpx - 4, heroTint)
  // the bought ware on its way to Kaneed, in an arc over the counter
  if (shopAt && s.obj?.shop && s.obj.shop.pick >= 0 && s.obj.t >= SHOP_FLY && s.obj.t < SHOP_GIVE) {
    const p = (s.obj.t - SHOP_FLY) / (SHOP_GIVE - SHOP_FLY)
    const from = { x: shopAt.iconX + s.obj.shop.pick * SHELF_STEP, y: shopAt.iconY }
    const to = { x: HERO_X + Math.floor(heroW / 2) - 3, y: heroY + 2 }
    canvas.blit(iconOf(s.obj.shop.shelf[s.obj.shop.pick]), Math.round(from.x + (to.x - from.x) * p), Math.round(from.y + (to.y - from.y) * p - Math.sin(p * Math.PI) * 6))
  }

  const cells = canvas.cells()
  // effects: bursts on hits, floating numbers, the foe's name and bar
  for (const b of s.bursts) {
    const glyphs = b.big ? ['✸', '✦', '✧'] : ['✦', '✧', '·']
    put(cells, b.x, b.y, glyphs[Math.min(glyphs.length - 1, 3 - b.ttl)] ?? '·', b.big ? 'yellowBright' : 'whiteBright', true)
    if (b.big) {
      put(cells, b.x - 2, b.y - 1, '✧', 'yellow')
      put(cells, b.x + 3, b.y + 1, '✧', 'yellow')
    }
  }
  for (const f of s.floats) put(cells, f.x, f.y, f.text, f.color, f.bold)
  if (s.foe && foePx && s.foe.state !== 'leave') {
    // name and bar to the right of the sprite, level with its head
    const lx = Math.round(s.foe.x) + widthOf(foePx) + 2
    const top = Math.max(0, Math.floor((groundPx - foePx.length) / 2))
    const label = `${s.foe.boss ? '★ ' : ''}${s.foe.name} Lv${s.foe.lv}`
    put(cells, lx, top, label, s.foe.boss ? 'redBright' : 'white', true)
    put(cells, lx, top + 1, `${bar(s.foe.hp, s.foe.maxHp, 10)} ${Math.max(0, s.foe.hp)}/${s.foe.maxHp}`, s.foe.hp / s.foe.maxHp < 0.3 ? 'red' : 'redBright')
  }
  if (shopAt && s.obj?.shop) shopText(cells, s.obj, s.obj.shop, shopAt)
  // the minimap: the real floor around Kaneed, one cell per tile, explored tiles only; it steps
  // aside while the shop is open, since the counter stands where the map does
  if (!(s.obj?.kind === 'shop' && s.obj.t < SHOP_END)) minimap(cells, s, cols, stageRows)

  const banner = s.banners[0]
  const foeName = s.foe ? KINDS[SPRITE_KEYS.indexOf(s.foe.key.replace('_boss', ''))]?.name ?? s.foe.name : ''
  const status = banner ? banner.text
    : sim.phase === 'dead' ? `カニード は倒れた… まもなく Lv 1 からやり直す`
    : sim.phase === 'fight' && s.foe ? `${foeName}${s.foe.boss ? '（ボス）' : ''} と戦闘中`
    : s.working ? `B${sim.floorNum}F を探索中… 残る敵 ${sim.enemies.length} 体   歩数 ${hero.steps}`
    : `Claude の応答待ち。カニード は B${sim.floorNum}F で休憩中（HP は回復しない）`
  return (
    <Box flexDirection="column">
      {header}
      {cells.map(line => row(Text, line))}
      <Text color={banner?.color ?? (sim.phase === 'dead' ? 'red' : undefined)} bold={banner?.bold} dimColor={!banner && sim.phase !== 'dead'} wrap="truncate-end">{status}</Text>
    </Box>
  )
}

// per-frame bookkeeping of everything that moves
function advance(s: Local, cols: number) {
  if (s.hold > 0) s.hold--
  if (s.heroFlash > 0) s.heroFlash--
  if (s.foeFlash > 0) s.foeFlash--
  if (s.heroGlow > 0) s.heroGlow--
  if (s.victory > 0) s.victory--
  if (s.descend > 0) {
    s.descend--
    s.heroDx = Math.min(12, s.heroDx + 1)
    if (s.descend === 0) {
      s.heroDx = 0
      s.obj = null
    }
  }
  for (const f of s.floats) {
    f.ttl--
    if (f.ttl % 2 === 0 && f.y > 0) f.y--
  }
  s.floats = s.floats.filter(f => f.ttl > 0)
  for (const b of s.bursts) b.ttl--
  s.bursts = s.bursts.filter(b => b.ttl > 0)
  if (s.banners.length) {
    s.banners[0].ttl--
    if (s.banners[0].ttl <= 0) s.banners.shift()
  }
  if (s.obj) {
    s.obj.t++
    if (s.obj.kind === 'shop' && s.obj.shop && s.obj.t === SHOP_GIVE) shopGive(s, s.obj.shop)
    // an opened chest is left behind once Kaneed walks on; the stairs go with the descent
    if ((s.obj.kind === 'chest' || s.obj.kind === 'shop') && s.obj.dx < -(HERO_X + 40)) s.obj = null
  }
  if (s.foe) {
    const f = s.foe
    if (f.state === 'enter') {
      f.x = Math.max(f.home, f.x - 8)
      if (f.x === f.home) f.state = 'idle'
    } else if (f.state === 'dying') {
      f.t++
      if (f.t > 6) s.foe = null
    } else if (f.state === 'leave') {
      f.x += 6
      if (f.x > cols + 2) s.foe = null
    } else if (s.sim.phase === 'explore' && !s.anim && s.hold <= 0) f.state = 'leave'
  }
  // the exchange of blows: Kaneed steps in and strikes, then the foe answers, five frames in all
  const a = s.anim
  if (a && a.t < 0) a.t++
  else if (a) {
    const heroPx = spriteOf(heroFrameKey('idle', 0))
    const foeX = s.foe ? Math.round(s.foe.x) : HERO_X + widthOf(heroPx) + 12
    const foeW = s.foe ? widthOf(spriteOf(s.foe.key)) : 12
    if (a.t === 0) {
      s.heroDx = 3
      if (s.foe) s.foeFlash = a.heroHits.length ? 2 : 0
      let dy = 0
      for (const hit of a.heroHits) {
        s.bursts.push({ x: foeX + 1, y: 2 + dy, ttl: 3, big: hit.crit })
        s.floats.push({ x: foeX + Math.floor(foeW / 2) - 1, y: 1 + dy, text: hit.crit ? `${hit.dmg}!!` : `${hit.dmg}`, color: hit.crit ? 'yellowBright' : 'whiteBright', ttl: 12, bold: true })
        dy++
      }
    } else if (a.t === 1) s.heroDx = 1
    else if (a.t === 2) {
      s.heroDx = 0
      if (a.foeHits.length) {
        s.foeDx = -3
        let dy = 0
        for (const hit of a.foeHits) {
          const hw = widthOf(heroPx)
          if (hit === 'miss') s.floats.push({ x: HERO_X + hw - 2, y: 1 + dy, text: 'MISS', color: 'cyanBright', ttl: 10, bold: true })
          else {
            s.heroFlash = 2
            s.bursts.push({ x: HERO_X + hw - 3, y: 2 + dy, ttl: 3, big: false })
            s.floats.push({ x: HERO_X + hw - 1, y: 1 + dy, text: `${hit.dmg}`, color: 'redBright', ttl: 12, bold: true })
          }
          dy++
        }
      }
    } else if (a.t === 3) s.foeDx = -1
    else if (a.t >= 4) {
      s.foeDx = 0
      s.anim = null
    }
    if (s.anim) a.t++
  }
}

// a tick's events become the next frames' motion
function apply(s: Local, events: GameEvent[], cols: number) {
  const heroPx = spriteOf(heroFrameKey('idle', 0))
  const heroW = widthOf(heroPx)
  let anim: TickAnim | null = null
  let engaged = false
  for (const e of events) {
    switch (e.type) {
      case 'step':
        s.scroll++
        s.walk ^= 1
        if (s.obj?.kind === 'chest' || (s.obj?.kind === 'shop' && s.obj.t >= SHOP_END)) s.obj.dx -= 2
        break
      case 'engage': {
        const key = SPRITE_KEYS[e.kind] + (e.boss ? '_boss' : '')
        s.foe = { key, name: KINDS[e.kind].name, boss: e.boss, lv: e.lv, hp: e.hp, maxHp: e.maxHp, x: cols + 2, home: HERO_X + heroW + 12, state: 'enter', t: 0 }
        s.banners.push({ text: `${e.boss ? '★ ボス ' : ''}${KINDS[e.kind].name} Lv ${e.lv} が現れた！`, color: e.boss ? 'redBright' : 'yellow', ttl: 15, bold: e.boss })
        engaged = true
        s.hold = Math.max(s.hold, 14)
        break
      }
      case 'hit':
        anim ??= { heroHits: [], foeHits: [], t: 0 }
        if (e.target === 'foe') {
          anim.heroHits.push({ dmg: e.dmg, crit: e.crit })
          if (s.foe) s.foe.hp = e.hpLeft
        } else anim.foeHits.push({ dmg: e.dmg })
        break
      case 'miss':
        anim ??= { heroHits: [], foeHits: [], t: 0 }
        anim.foeHits.push('miss')
        break
      case 'kill':
        if (s.foe) {
          s.foe.state = 'dying'
          s.foe.t = 0
          const fw = widthOf(spriteOf(s.foe.key))
          s.floats.push({ x: Math.round(s.foe.x) + fw + 2, y: 2, text: `+${e.xp} XP`, color: 'greenBright', ttl: 14, bold: true })
          s.floats.push({ x: Math.round(s.foe.x) + fw + 10, y: 4, text: `+${e.gold} G`, color: 'yellow', ttl: 16 })
        }
        s.banners.push({ text: `${KINDS[e.kind].name} を倒した！  +${e.xp} XP  +${e.gold} G`, color: 'green', ttl: 12 })
        s.victory = 10
        s.hold = Math.max(s.hold, 10)
        break
      case 'levelup':
        s.banners.push({ text: `LEVEL UP!  カニード は Lv ${e.lv} になった  HP ${e.hp}`, color: 'greenBright', ttl: 22, bold: true })
        s.floats.push({ x: HERO_X + 2, y: 0, text: 'LEVEL UP!', color: 'greenBright', ttl: 16, bold: true })
        s.heroGlow = 14
        s.hold = Math.max(s.hold, 14)
        break
      case 'item': {
        const color = RARITY_COLORS[e.rarity - 1]
        const verdict = !e.replaced ? '装備した' : e.better ? `${e.replaced} から持ち替え ↑ 強化` : `${e.replaced} から持ち替え ↓ 弱体化！`
        s.banners.push({ text: `${e.name}${e.wizard ? '✦' : ''}［${rarityName({ slot: 'hat', tier: 1, rarity: e.rarity as 1 })}］ を${verdict}`, color: e.better || !e.replaced ? color : 'red', ttl: 26, bold: e.rarity >= 4 })
        s.floats.push({ x: HERO_X + 3, y: 0, text: e.better || !e.replaced ? 'EQUIP ↑' : 'EQUIP ↓', color: e.better || !e.replaced ? color : 'red', ttl: 16, bold: true })
        s.hold = Math.max(s.hold, 20)
        break
      }
      case 'chest':
        s.obj = { kind: 'chest', t: 0, dx: 0 }
        s.banners.push({ text: `宝箱を見つけた！  開けると ${e.gold} G が入っていた`, color: 'yellowBright', ttl: 18 })
        for (let i = 0; i < 4; i++) s.bursts.push({ x: HERO_X + heroW + 12 + 2 + i * 2, y: 2 + (i % 2), ttl: 3 + i, big: false })
        s.hold = Math.max(s.hold, 22)
        break
      case 'shop':
        s.obj = { kind: 'shop', t: 0, dx: 0, shop: e }
        s.foe = null
        s.banners.push({ text: 'ショップを見つけた！  店長「いらっしゃい！ 好きなのを 1 つ選んでおくれ」', color: 'yellowBright', ttl: SHOP_LAND, bold: true })
        s.banners.push(e.pick < 0
          ? { text: `所持金 ${e.gold} G… 棚の品はどれも買えない`, color: 'yellow', ttl: SHOP_GIVE - SHOP_LAND }
          : { text: `カニード は ${wareName(e.shelf[e.pick])} を選んだ！（${priceOf(e.shelf[e.pick], e.lv)} G）`, color: 'yellowBright', ttl: SHOP_GIVE - SHOP_LAND, bold: true })
        s.hold = Math.max(s.hold, SHOP_END + 2)
        break
      case 'descend':
        s.obj = { kind: 'stairs', t: 0, dx: 0 }
        s.foe = null
        s.descend = 24
        s.banners.push({ text: `階段を見つけた… B${e.floor}F へ降りる`, color: 'cyanBright', ttl: 26, bold: true })
        s.hold = Math.max(s.hold, 26)
        break
      case 'heal':
        s.floats.push({ x: HERO_X + 4, y: 1, text: `+${e.amount}`, color: 'greenBright', ttl: 14, bold: true })
        s.banners.push({ text: `テスト成功！  カニード の HP が ${e.amount} 回復した`, color: 'greenBright', ttl: 20, bold: true })
        s.heroGlow = 10
        break
      case 'die':
        s.dead = true
        s.anim = null
        s.banners = [{ text: `カニード は ${e.by} に倒された…  冒険はここで終わり。Lv 1 からやり直す`, color: 'red', ttl: 40, bold: true }]
        s.hold = 0
        break
      case 'respawn':
        s.dead = false
        s.foe = null
        s.obj = null
        s.floats = []
        s.banners.push({ text: `冒険 #${e.run} が始まった。Lv 1、装備なし、B1F から`, color: HERO_COLOR, ttl: 26, bold: true })
        break
      case 'rebuild':
        s.foe = null
        s.obj = null
        s.banners.push({ text: 'コンテキスト圧縮の余波で壁が組み替わった。同じ階を歩き直す', color: 'magenta', ttl: 22 })
        break
    }
  }
  if (anim) {
    // a foe that has just appeared walks in first; the blows land when it arrives
    if (engaged) anim.t = -Math.ceil((cols + 2 - (HERO_X + heroW + 12)) / 8) - 1
    s.anim = anim
  }
}

// the shop stands where a foe would: a counter with three wares on it, the keeper behind it to the
// right, a shelf of jars on the wall when the stage is tall enough. Answers where the wares sit.
type ShopAt = { iconX: number; iconY: number; counterY: number; keeperX: number; keeperY: number }
function drawShop(canvas: Canvas, obj: Obj, x0: number, groundPx: number): ShopAt {
  const v = obj.shop!
  const counterY = Math.max(ICON_H + 2, groundPx - 6)
  const keeper = fit(snapAll(SHOPKEEPER), 'shopkeeper', Math.max(8, canvas.hpx - 4))
  const keeperX = x0 + SHELF_W + 2
  const keeperY = groundPx - keeper.length
  // the wall shelf and its jars, above the wares
  const wallY = counterY - ICON_H - 9
  if (wallY >= 3) {
    for (let x = x0; x < keeperX + widthOf(keeper); x++) canvas.set(x, wallY, WOOD)
    for (let i = 0; i < 5; i++) {
      const jx = x0 + 2 + i * 9
      const c = ['#5f87af', '#87af5f', '#af5f87', '#d7af5f', '#5fafaf'][i]
      for (let y = wallY - 3; y < wallY; y++) for (let x = jx; x < jx + 3; x++) canvas.set(x, y, y === wallY - 3 ? '#bcbcbc' : c)
    }
  }
  canvas.blit(keeper, keeperX, keeperY)
  // the counter, in front of the keeper's legs
  for (let y = counterY; y < groundPx; y++)
    for (let x = x0 - 1; x < keeperX + 3; x++)
      canvas.set(x, y, y === counterY ? WOOD_TOP : y === groundPx - 1 || (x - x0) % SHELF_STEP === 0 ? WOOD_DARK : WOOD)
  const iconX = x0 + 2
  const iconY = counterY - ICON_H
  const cursor = shopCursor(v, obj.t)
  for (let i = 0; i < v.shelf.length; i++) {
    const x = iconX + i * SHELF_STEP
    const bought = i === v.pick && obj.t >= SHOP_FLY
    // the picked ware hops while it blinks
    const lift = i === v.pick && obj.t >= SHOP_LAND && obj.t < SHOP_FLY ? (obj.t % 2) : 0
    if (!bought) canvas.blit(iconOf(v.shelf[i]), x, iconY - lift)
    if (i === cursor && !(obj.t >= SHOP_LAND && obj.t % 2 === 1 && i === v.pick) && obj.t < SHOP_FLY) {
      const c = obj.t >= SHOP_LAND ? '#ffffff' : '#ffd700'
      for (let dx = -1; dx <= ICON_W; dx++) {
        canvas.set(x + dx, iconY - 2, c)
        canvas.set(x + dx, counterY, c)
      }
      for (let dy = -2; dy <= ICON_H; dy++) {
        canvas.set(x - 1, iconY + dy, c)
        canvas.set(x + ICON_W, iconY + dy, c)
      }
    }
  }
  return { iconX, iconY, counterY, keeperX, keeperY }
}

// the words over the shop: a sign, the prices under the wares, the keeper's line
function shopText(cells: Cell[][], obj: Obj, v: ShopVisit, at: ShopAt) {
  const priceRow = Math.floor(at.counterY / 2) + 1
  for (let i = 0; i < v.shelf.length; i++) {
    const w = v.shelf[i]
    const price = priceOf(w, v.lv)
    const x = at.iconX - 1 + i * SHELF_STEP
    if (i === v.pick && obj.t >= SHOP_FLY) put(cells, x, priceRow, ' 売約 ', '#bcbcbc', false, WOOD_DARK)
    else put(cells, x, priceRow, `${price}G`.padStart(5), price <= v.gold ? 'yellowBright' : 'redBright', true, WOOD_DARK)
  }
  // the sign sits a row above the cursor's top edge
  const signRow = Math.floor((at.iconY - 2) / 2) - 1
  if (signRow >= 1 && obj.t < SHOP_END) put(cells, at.iconX + 6, signRow, '＊ショップ＊', 'yellowBright', true)
  const line = obj.t < SHOP_LAND ? '「いらっしゃい！」'
    : v.pick < 0 ? '「お金が足りないね…また来ておくれ」'
    : obj.t < SHOP_GIVE ? `「${wareName(v.shelf[v.pick])} だね！」`
    : '「まいどあり！」'
  // the keeper's line, pulled left when a narrow band would cut it off
  const width = cells[0]?.length ?? 0
  if (obj.t < SHOP_END + 6) put(cells, Math.max(0, Math.min(at.keeperX - 2, width - cellWidth(line) - 1)), Math.max(0, Math.floor(at.keeperY / 2) - 1), line, 'whiteBright', true)
}

// the ware reaches Kaneed: the gold goes, then the heal or the new piece shows
function shopGive(s: Local, v: ShopVisit) {
  if (v.pick < 0) {
    s.banners.push({ text: `所持金 ${v.gold} G では何も買えなかった… カニード はしょんぼり店を出た`, color: 'yellow', ttl: 20 })
    return
  }
  const w = v.shelf[v.pick]
  const price = priceOf(w, v.lv)
  const heroW = widthOf(spriteOf(heroFrameKey('idle', 0)))
  s.floats.push({ x: HERO_X + heroW + 2, y: 3, text: `-${price} G`, color: 'yellow', ttl: 16, bold: true })
  s.victory = 10
  if (w.kind !== 'gear') {
    s.floats.push({ x: HERO_X + 4, y: 1, text: `+${v.healed}`, color: 'greenBright', ttl: 14, bold: true })
    s.banners.push({ text: `${wareName(w)} を ${price} G で購入！  カニード の HP が ${v.healed} 回復した`, color: 'greenBright', ttl: 22, bold: true })
    s.heroGlow = 14
    return
  }
  const item = v.item!
  const color = RARITY_COLORS[item.rarity - 1]
  const good = item.better || !item.replaced
  const verdict = !item.replaced ? '装備した' : item.better ? `${item.replaced} から持ち替え ↑ 強化` : `${item.replaced} から持ち替え ↓ 弱体化！`
  s.banners.push({ text: `${wareName(w)} を ${price} G で購入し、${verdict}`, color: good ? color : 'red', ttl: 26, bold: item.rarity >= 4 })
  s.floats.push({ x: HERO_X + 3, y: 0, text: good ? 'EQUIP ↑' : 'EQUIP ↓', color: good ? color : 'red', ttl: 16, bold: true })
  s.heroGlow = 10
}

function minimap(cells: Cell[][], s: Local, cols: number, stageRows: number) {
  const sim = s.sim
  const f = sim.floor
  const mw = Math.min(32, Math.max(16, Math.floor(cols / 4)))
  // the map reaches down to the floor, so a foe walking in from the right emerges from behind it
  const mh = Math.max(4, stageRows - 2)
  const x0 = cols - mw - 2
  const y0 = 0
  const left = Math.max(0, Math.min(f.w - mw, sim.pos.x - Math.floor(mw / 2)))
  const top = Math.max(0, Math.min(f.h - mh, sim.pos.y - Math.floor(mh / 2)))
  const enemyAt = new Set(sim.enemies.map(e => `${e.x},${e.y}`))
  const frame = '#875f5f'
  put(cells, x0, y0, '╭' + '─'.repeat(mw) + '╮', frame)
  for (let r = 0; r < mh; r++) {
    put(cells, x0, y0 + 1 + r, '│', frame)
    for (let c = 0; c < mw; c++) {
      const x = left + c
      const y = top + r
      let ch = ' '
      let color: string | undefined
      let bold = false
      if (x === sim.pos.x && y === sim.pos.y) { ch = '@'; color = HERO_COLOR; bold = true }
      else if (sim.explored[idx(f, x, y)]) {
        if (enemyAt.has(`${x},${y}`)) { ch = 'x'; color = 'redBright' }
        else switch (tileAt(f, x, y)) {
          case T.WALL: ch = '▒'; color = '#585858'; break
          case T.STAIRS: ch = '>'; color = 'cyanBright'; bold = true; break
          case T.CHEST: ch = '$'; color = 'yellowBright'; bold = true; break
          case T.SHOP: ch = 'S'; color = 'magentaBright'; bold = true; break
          case T.SHOP_CLOSED: ch = 's'; color = '#8a8a8a'; break
          default: ch = '·'; color = '#8a8a8a'
        }
      }
      put(cells, x0 + 1 + c, y0 + 1 + r, ch, color, bold, '#121212')
    }
    put(cells, x0 + 1 + mw, y0 + 1 + r, '│', frame)
  }
  put(cells, x0, y0 + 1 + mh, '╰' + '─'.repeat(mw) + '╯', frame)
  put(cells, x0 + 2, y0 + 1 + mh, ` B${sim.floorNum}F 敵${sim.enemies.length} `, '#8a8a8a')
}

// the status sheet: the big Kaneed (the same sprite, breathing), its numbers, its five slots
function statusView(s: Local, header: RenderElement, Box: ClientElements['Box'], Text: ClientElements['Text']) {
  const hero = s.sim.hero
  const st = stats(hero)
  const hpRatio = st.maxHp ? hero.hp / st.maxHp : 0
  const lowHp = hpRatio <= 0.25
  const heroPx = spriteOf(heroFrameKey('idle', 0))
  const canvas = new Canvas(widthOf(heroPx) + 4, heroPx.length + 4)
  for (let i = 0; i < canvas.buf.length; i++) canvas.buf[i] = '#12100D'
  const bob = Math.floor(s.frame / 8) % 2
  drawHero(canvas, hero, s.dead ? 'dead' : 'idle', bob, 2, 2 + bob - (s.dead ? -1 : 0), 99, s.dead ? (c: string) => gray(c) : lowHp && s.frame % 10 < 5 ? (c: string) => mix(c, '#ff4040', 0.25) : undefined)
  const portrait = canvas.cells().map(line => row(Text, line))
  const lines = SLOTS.map(slot => {
    const item = hero.equipment[slot]
    return (
      <Text wrap="truncate-end">
        <Text dimColor>{`${SLOT_LABEL[slot].padEnd(6, '\u3000')} `}</Text>
        {item ? <Text color={rarityColor(item)} bold={item.rarity >= 4}>{`${itemName(item)}${isWizardItem(item) ? '✦' : ''} `}</Text> : <Text dimColor>{'（なし） '}</Text>}
        {item ? <Text dimColor>{`T${item.tier} ${rarityName(item)}`}</Text> : null}
      </Text>
    )
  })
  const face = s.dead ? 'カニード は倒れている…' : lowHp ? 'カニード はふらふらだ。テストを通してあげて' : hpRatio <= 0.5 ? 'カニード は少し疲れている' : s.working ? 'カニード は元気に探索中' : 'カニード は休憩中'
  return (
    <Box flexDirection="column">
      {header}
      <Box flexDirection="row" columnGap={3}>
        <Box flexDirection="column">{portrait}</Box>
        <Box flexDirection="column">
          <Text color={HERO_COLOR} bold>{face}</Text>
          <Text>{`攻撃 ${st.atk.toFixed(1)}   防御 ${st.def.toFixed(1)}   会心 ${st.crit.toFixed(0)}%   回避 ${st.evade.toFixed(0)}%`}</Text>
          {lines}
          <Text dimColor>{`歩数 ${hero.steps}   討伐 ${hero.kills}   テスト回復 ${s.heals} 回   テスト失敗 ${s.fails} 回`}</Text>
        </Box>
      </Box>
      <Text dimColor wrap="truncate-end">{'回復は Lv アップ（50%）とテスト成功（35%）、ショップ（見つけたときだけ）。拾った装備は必ず持ち替える。倒れると Lv 1 から。✦ は魔法使いの装備'}</Text>
    </Box>
  )
}

// the log: recent lines, then the runs that ended
function logView(s: Local, props: Props, header: RenderElement, rows: number, Box: ClientElements['Box'], Text: ClientElements['Text']) {
  const hall = props?.hall ?? []
  const hallLines = hall.slice(-3).reverse().map(r => `#${r.run}  Lv ${r.lv}  B${r.floor}F  ⚔ ${r.kills}  ${r.killedBy} に倒された`)
  const room = rows - 1 - (hallLines.length ? hallLines.length + 1 : 0)
  const lines = s.sim.log.slice(-Math.max(1, room))
  return (
    <Box flexDirection="column">
      {header}
      {lines.map(line => <Text wrap="truncate-end" dimColor={!/成功|レベルアップ|倒された|宝箱|手に入れ|ショップ|購入/.test(line)} color={/倒された/.test(line) ? 'red' : /成功|レベルアップ/.test(line) ? 'green' : /宝箱|手に入れ|ショップ|購入/.test(line) ? 'yellow' : undefined}>{`· ${line}`}</Text>)}
      {hallLines.length ? <Text bold dimColor>{'── これまでの冒険 ──'}</Text> : null}
      {hallLines.map(line => <Text dimColor wrap="truncate-end">{line}</Text>)}
    </Box>
  )
}

// ---- the dashboard: this session, in numbers ----
// Five sections, each a list of lines in the order they matter: what Claude's turns spent, the
// turns that spent the most, what the context window holds and what is left of the usage windows,
// the events the hooks module caught, and Kaneed's record. Wide bands put them side by side;
// narrow ones stack them and give each a share of the rows.

const LABEL_W = 11
const VALUE_W = 10

type Els = { Box: ClientElements['Box']; Text: ClientElements['Text'] }

// label, bar or sparkline, value: one chart row that fits `w` cells
function chartLine({ Text }: Els, w: number, label: string, line: string, value: string, color: string, labelW = LABEL_W) {
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{padCells(label, labelW)}</Text>
      <Text color={color}>{line}</Text>
      <Text bold>{' ' + padCells(value, VALUE_W - 1)}</Text>
    </Text>
  )
}

const title = ({ Text }: Els, text: string, color: string, note = '') => (
  <Text wrap="truncate-end">
    <Text color={color} bold>{`▌${text}`}</Text>
    <Text dimColor>{note ? `  ${note}` : ''}</Text>
  </Text>
)

// plain numbers, `label 値` pairs on one line: for what a chart would only blur
const factLine = ({ Text }: Els, pairs: [string, string][]) => (
  <Text wrap="truncate-end">
    {pairs.map(([label, value], i) => (
      <Text>
        <Text dimColor>{`${i ? '   ' : ''}${label} `}</Text>
        <Text bold>{value}</Text>
      </Text>
    ))}
  </Text>
)

const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—')

// one bar of `width` cells split by share, each part in its colour; the cells rounding leaves over
// go to the largest remainders, so a part with anything in it keeps a cell
function stackedBar({ Text }: Els, width: number, parts: { value: number; color: string }[]) {
  const total = parts.reduce((a, p) => a + p.value, 0)
  if (total <= 0) return <Text dimColor>{' '.repeat(width)}</Text>
  const exact = parts.map(p => (p.value / total) * width)
  const cells = exact.map(Math.floor)
  let left = width - cells.reduce((a, n) => a + n, 0)
  const order = exact.map((v, i) => [v - cells[i], i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left <= 0) break
    if (parts[i].value <= 0) continue
    cells[i]++
    left--
  }
  return <Text wrap="truncate-end">{parts.map((p, i) => <Text color={p.color}>{'█'.repeat(cells[i])}</Text>)}</Text>
}

// claude-opus-5-20260101 reads as opus-5
const modelLabel = (id: string) => id.replace(/^claude-/, '').replace(/-\d{6,}$/, '') || id
const LIMIT_LABEL: Record<string, string> = { five_hour: '5 時間枠', seven_day: '7 日枠', spend_limit: '上限額' }
const resetLabel = (iso: string | undefined) => {
  if (!iso) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const today = new Date()
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth() && at.getDate() === today.getDate()
  return sameDay ? time : `${at.getMonth() + 1}/${at.getDate()} ${time}`
}

// what the session spent, and on what: the four kinds as shares of the whole, how much of the
// input came back from the cache, the run of turns, and the split by loop and by model
function tokenSection(els: Els, d: Dash, w: number): RenderElement[] {
  const { Text } = els
  const sw = Math.max(4, w - LABEL_W - VALUE_W)
  const t = d.totals
  const all = tokenTotal(t)
  const usd = d.context.usd
  const perTurn = usd !== null && d.mainTurns > 0 ? usd / d.mainTurns : null
  const notes = [`計 ${compact(all)}`, usd !== null ? `$${usd.toFixed(2)}` : '', perTurn !== null ? `$${perTurn.toFixed(2)}/ターン` : ''].filter(Boolean).join('  ')
  const parts = [
    { label: '出力', value: t.output, color: 'magenta' },
    { label: '入力', value: t.input, color: 'cyan' },
    { label: 'Cache 読込', value: t.cacheRead, color: 'blue' },
    { label: 'Cache 作成', value: t.cacheWrite, color: 'yellow' },
  ]
  const lines: RenderElement[] = [title(els, 'トークン', 'cyan', notes), stackedBar(els, w, parts)]
  for (const p of parts) lines.push(chartLine(els, w, p.label, hbar(p.value, Math.max(1, all), sw), compact(p.value), p.color))
  const hit = cacheHitRate(t)
  if (hit !== null) lines.push(<Text dimColor wrap="truncate-end">{`入力の ${Math.round(hit * 100)}% はキャッシュから読まれた`}</Text>)
  lines.push(chartLine(els, w, 'ターン別', spark(d.turns.map(tokenTotal), sw), `${d.turns.length} 本`, 'cyanBright'))
  // by loop: the main conversation, then the subagents, those of one type counted together and
  // named as the roster names them (an id the roster has not reached is numbered as it appeared)
  const subs = Object.keys(d.loops).filter(id => id !== 'main')
  const groups = new Map<string, { label: string; tokens: number; turns: number; runs: number; main: boolean }>()
  for (const [id, loop] of Object.entries(d.loops)) {
    const main = id === 'main'
    const type = d.kinds[id]?.type ?? ''
    const key = main ? 'main' : type || id
    const group = groups.get(key) ?? { label: main ? 'メイン' : type || `サブ #${subs.indexOf(id) + 1}`, tokens: 0, turns: 0, runs: 0, main }
    group.tokens += tokenTotal(loop)
    group.turns += loop.turns
    group.runs++
    groups.set(key, group)
  }
  const ranked = [...groups.values()].sort((a, b) => b.tokens - a.tokens)
  const loopMax = Math.max(1, ...ranked.map(g => g.tokens))
  for (const group of ranked) {
    const name = group.runs > 1 ? `${group.label} ×${group.runs}` : group.label
    lines.push(chartLine(els, w, name, hbar(group.tokens, loopMax, sw), `${compact(group.tokens)} /${group.turns}`, group.main ? 'green' : 'blueBright'))
  }
  const models = Object.entries(d.models).sort((a, b) => tokenTotal(b[1]) - tokenTotal(a[1]))
  if (models.length > 1) {
    const modelMax = Math.max(1, ...models.map(([, v]) => tokenTotal(v)))
    for (const [id, v] of models) lines.push(chartLine(els, w, modelLabel(id), hbar(tokenTotal(v), modelMax, sw), compact(tokenTotal(v)), 'magentaBright'))
  } else if (models.length === 1) {
    lines.push(<Text dimColor wrap="truncate-end">{`モデル ${modelLabel(models[0][0])}`}</Text>)
  }
  if (!d.turns.length) lines.splice(1, 0, <Text dimColor wrap="truncate-end">{'  ターンが終わると数字が入る'}</Text>)
  return lines
}

// a subagent turn reads as what the roster calls it, with the task it was given
function agentLabel(d: Dash, agentId: string | undefined): string {
  if (agentId === undefined) return 'プロンプトなし'
  const kind = d.kinds[agentId]
  if (!kind) return 'サブエージェント'
  return kind.description ? `${kind.type || 'サブ'}: ${kind.description}` : kind.type || 'サブエージェント'
}

// which turns cost the most: the prompt each answered, what it spent, how long it ran
function heavySection(els: Els, d: Dash): RenderElement[] {
  const { Text } = els
  const lines: RenderElement[] = [title(els, '重かったターン', 'magenta', d.heavy.length ? `上位 ${d.heavy.length}` : '')]
  if (!d.heavy.length) lines.push(<Text dimColor wrap="truncate-end">{'  ターンが終わると並ぶ'}</Text>)
  for (const p of d.heavy) {
    lines.push(
      <Text wrap="truncate-end">
        <Text color="magenta" bold>{padCells(compact(tokenTotal(p)), 7)}</Text>
        <Text color="green">{padCells(p.usd !== undefined ? `$${p.usd.toFixed(2)}` : '', 7)}</Text>
        <Text dimColor>{padCells(duration(p.ms), 7)}</Text>
        <Text>{p.label ?? agentLabel(d, p.agentId)}</Text>
      </Text>,
    )
  }
  const stopped = d.turns.filter(p => p.reason !== 'answer')
  const avgMs = d.turns.length ? d.turns.reduce((a, p) => a + p.ms, 0) / d.turns.length : 0
  lines.push(<Text dimColor wrap="truncate-end">{`ターン ${d.mainTurns}  サブエージェント ${d.agentCount}（${d.agentTurns} ターン）  平均 ${duration(avgMs)}  中断・エラー ${stopped.length}`}</Text>)
  return lines
}

// what the window holds, as /context breaks it down
function contextSection(els: Els, d: Dash, w: number): RenderElement[] {
  const { Text } = els
  const nameW = LABEL_W + 4
  const sw = Math.max(4, w - nameW - VALUE_W)
  const ctx = d.context
  const fill = ctx.percent
  const lines: RenderElement[] = [
    title(els, 'コンテキスト', 'blueBright', ctx.tokens !== null && ctx.window ? `${compact(ctx.tokens)} / ${compact(ctx.window)}` : ''),
  ]
  if (fill !== null) lines.push(chartLine(els, w, '使用率', hbar(fill, 100, sw), `${Math.round(fill)}%`, fill >= 85 ? 'red' : fill >= 60 ? 'yellow' : 'green', nameW))
  const bd = ctx.breakdown
  if (bd) {
    const used = bd.slices.filter(slice => slice.kind === 'used' && slice.tokens > 0).sort((a, b) => b.tokens - a.tokens)
    const max = Math.max(1, ...used.map(slice => slice.tokens))
    for (const slice of used.slice(0, 4)) lines.push(chartLine(els, w, slice.name, hbar(slice.tokens, max, sw), compact(slice.tokens), 'blue', nameW))
    const rest = used.slice(4).reduce((a, slice) => a + slice.tokens, 0)
    const free = bd.slices.find(slice => slice.kind === 'free')
    lines.push(<Text dimColor wrap="truncate-end">{`${rest > 0 ? `ほか ${compact(rest)}  ` : ''}${free ? `空き ${compact(free.tokens)}  ` : ''}圧縮 ${d.events['圧縮'] ?? 0} 回`}</Text>)
  } else {
    lines.push(<Text dimColor wrap="truncate-end">{'  内訳はダッシュボードを開くと集計される'}</Text>)
  }
  return lines
}

// how much of each usage window the account has spent, and when it comes back
function limitSection(els: Els, d: Dash, w: number): RenderElement[] {
  const { Text } = els
  const nameW = LABEL_W + 4
  const sw = Math.max(4, w - nameW - VALUE_W)
  const limits = d.context.rateLimits
  if (!limits.length) return []
  const lines: RenderElement[] = [title(els, '利用上限', 'yellow')]
  for (const limit of limits) {
    const used = limit.percentUsed
    lines.push(chartLine(els, w, LIMIT_LABEL[limit.kind] ?? limit.kind, hbar(used, 100, sw), `${Math.round(used)}%`, used >= 85 ? 'red' : used >= 60 ? 'yellow' : 'green', nameW))
  }
  // the windows come back one after another, so their times share a line
  const resets = limits.map(limit => resetLabel(limit.resetsAt)).filter(Boolean)
  if (resets.length) lines.push(<Text dimColor wrap="truncate-end">{`回復 ${resets.join('  ')}`}</Text>)
  return lines
}

function eventSection(els: Els, d: Dash, w: number): RenderElement[] {
  const { Text } = els
  const sw = Math.max(4, w - LABEL_W - VALUE_W)
  const total = Object.values(d.events).reduce((a, n) => a + n, 0)
  const lines = [
    title(els, 'イベント', 'green', `計 ${total}`),
    chartLine(els, w, '毎分', spark(d.perMinute, sw), `${d.perMinute[d.perMinute.length - 1] ?? 0}/分`, 'green'),
  ]
  const kinds = Object.entries(d.events).sort((a, b) => b[1] - a[1])
  const tools = Object.entries(d.tools).sort((a, b) => b[1] - a[1])
  const max = Math.max(1, ...kinds.map(k => k[1]), ...tools.map(k => k[1]))
  const color = (label: string) => (label === 'テスト失敗' ? 'red' : label === 'テスト成功' ? 'greenBright' : label === '圧縮' ? 'yellow' : 'green')
  for (const [label, n] of kinds) lines.push(chartLine(els, w, label, hbar(n, max, sw), String(n), color(label)))
  if (tools.length) lines.push(<Text dimColor wrap="truncate-end">{'  ツール内訳'}</Text>)
  for (const [label, n] of tools) lines.push(chartLine(els, w, ` ${label}`, hbar(n, max, sw), String(n), 'blueBright'))
  if (!kinds.length) lines.push(<Text dimColor wrap="truncate-end">{'  まだイベントはない'}</Text>)
  return lines
}

// Kaneed's session record: only what the status sheet cannot show. Plain numbers, adding up across
// deaths, so a run that ended still counts.
function recordSection(els: Els, s: Local, d: Dash): RenderElement[] {
  const t = d.tally
  const since = duration(Date.now() - d.startedAt)
  return [
    title(els, 'ゲーム記録', HERO_COLOR, `このセッション ${since}  冒険 #${s.sim.hero.run}`),
    factLine(els, [['死亡', String(d.deaths)], ['最高到達', `B${d.maxFloor}F`], ['最高 Lv', String(d.maxLv)]]),
    factLine(els, [['撃破', `${t.kills}（ボス ${t.bossKills}）`], ['歩数', compact(d.steps)]]),
    factLine(els, [['攻撃', String(t.attacks)], ['会心', `${t.crits} (${percent(t.crits, t.attacks)})`], ['与ダメ', compact(t.dealt)]]),
    factLine(els, [['被弾', String(t.hitsTaken)], ['回避', `${t.dodges} (${percent(t.dodges, t.dodges + t.hitsTaken)})`], ['被ダメ', compact(t.taken)]]),
    factLine(els, [['回復', `${t.healTest + t.healLevel}（テスト ${t.healTest} / Lv ${t.healLevel}）`], ['+HP', compact(t.healed)]]),
    factLine(els, [['宝箱', String(t.chests)], ['装備', `${t.items}（弱体化 ${t.downgrades}）`]]),
    factLine(els, [['獲得', `${compact(t.gold)} G`], ['Lv アップ', String(d.levels)]]),
  ]
}

// sections stacked in one column. A section that fits at all gets its heading and a line under it
// (a heading alone says nothing), and then they grow line by line together until the rows run out,
// the ones higher up first.
function stack(sections: RenderElement[][], rows: number): RenderElement[] {
  const quota = sections.map(() => 0)
  let left = rows
  for (let i = 0; i < sections.length && left >= 2; i++) {
    if (!sections[i].length) continue
    quota[i] = Math.min(sections[i].length, 2)
    left -= quota[i]
  }
  while (left > 0) {
    let moved = false
    for (let i = 0; i < sections.length && left > 0; i++) {
      if (quota[i] === 0 || quota[i] >= sections[i].length) continue
      quota[i]++
      left--
      moved = true
    }
    if (!moved) break
  }
  return sections.flatMap((sec, i) => sec.slice(0, quota[i]))
}

function dashView(s: Local, d: Dash | undefined, header: RenderElement, cols: number, rows: number, Box: ClientElements['Box'], Text: ClientElements['Text']) {
  if (!d) return <Box flexDirection="column">{header}<Text dimColor>{'集計を読み込み中…'}</Text></Box>
  const els: Els = { Box, Text }
  const body = rows - 1
  const layout = cols >= 132 ? 3 : cols >= 84 ? 2 : 1
  const gap = 2
  const w = Math.floor((cols - gap * (layout - 1)) / layout)
  const tokens = tokenSection(els, d, w)
  const heavy = heavySection(els, d)
  const context = contextSection(els, d, w)
  const limits = limitSection(els, d, w)
  const events = eventSection(els, d, w)
  const record = recordSection(els, s, d)
  const columns = layout === 3 ? [tokens.slice(0, body), stack([heavy, events], body), stack([context, limits, record], body)]
    : layout === 2 ? [stack([tokens, heavy], body), stack([context, limits, record, events], body)]
    : [stack([tokens, heavy, context, limits, record, events], body)]
  return (
    <Box flexDirection="column">
      {header}
      <Box flexDirection="row" columnGap={gap}>
        {columns.map(lines => <Box flexDirection="column" width={w}>{lines}</Box>)}
      </Box>
    </Box>
  )
}
