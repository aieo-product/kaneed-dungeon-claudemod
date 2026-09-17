import { describe, expect, test } from 'bun:test'
import { bandRows, DEFAULTS, MAX_ROWS, MIN_ROWS, readSettings, wantScale } from '../hooks/game/settings.ts'

describe('settings', () => {
  test('a stored value is read back, and anything unrecognised falls back', () => {
    expect(readSettings(undefined)).toEqual(DEFAULTS)
    expect(readSettings({ rows: 16, scale: 0.5, minimap: false, skin: 'ai' })).toEqual({ rows: 16, scale: 0.5, minimap: false, skin: 'ai' })
    // a size the mod no longer offers (an older store said ×2) falls back rather than enlarging
    expect(readSettings({ scale: 2 }).scale).toBe('auto')
    // a value outside the choices, a wrong type, a hand-edited store
    expect(readSettings({ rows: 999, scale: 'huge', minimap: 'yes', skin: 5 })).toEqual(DEFAULTS)
    expect(readSettings('nonsense')).toEqual(DEFAULTS)
  })
  test('the band takes the rows asked for, inside the room the terminal has', () => {
    expect(bandRows({ ...DEFAULTS, rows: 'auto' }, 40)).toBe(MAX_ROWS)
    expect(bandRows({ ...DEFAULTS, rows: 'auto' }, 14)).toBe(13)
    expect(bandRows({ ...DEFAULTS, rows: 12 }, 40)).toBe(12)
    // asked for more than the terminal has: the terminal wins
    expect(bandRows({ ...DEFAULTS, rows: 22 }, 14)).toBe(13)
    // a tiny terminal still leaves the stage something to draw in
    expect(bandRows({ ...DEFAULTS, rows: 12 }, 4)).toBe(MIN_ROWS)
  })
  test('auto draws the art at the size it was made, and never larger', () => {
    expect(wantScale({ ...DEFAULTS, scale: 'auto' })).toBe(1)
    expect(wantScale({ ...DEFAULTS, scale: 0.5 })).toBe(0.5)
  })
})

// the stage's scale is worked out in the board, next to the drawing it is for
import { stageScale } from '../hooks/boards/dungeon.tsx'

describe('the stage scale', () => {
  test('the art is drawn at the size it was made, and only ever smaller', () => {
    // however tall the band is, the sprite is never enlarged
    expect(stageScale(16, 22, 1)).toBe(1)
    expect(stageScale(16, 48, 1)).toBe(1)
    // the smaller sizes are drawn as asked
    expect(stageScale(16, 48, 0.75)).toBe(0.75)
    expect(stageScale(16, 48, 0.5)).toBe(0.5)
    // a band too short even for the size asked for shrinks further
    expect(stageScale(16, 12, 1)).toBe(0.75)
    expect(stageScale(24, 12, 1)).toBe(0.5)
    expect(stageScale(16, 12, 0.5)).toBe(0.5)
  })
})

import { applySetting, SKIN_IDS } from '../hooks/game/settings.ts'
import { SKINS } from '../hooks/boards/dungeon.tsx'

describe('/kaneed set', () => {
  const set = (words: string) => applySetting(DEFAULTS, words.split(' '))
  test('each setting can be named from the keyboard', () => {
    expect(set('rows 16').settings.rows).toBe(16)
    expect(set('rows auto').settings.rows).toBe('auto')
    expect(set('size 0.5').settings.scale).toBe(0.5)
    expect(set('size ×0.75').settings.scale).toBe(0.75)
    // a percentage names the same size
    expect(set('size 50%').settings.scale).toBe(0.5)
    expect(set('size 75').settings.scale).toBe(0.75)
    expect(set('map off').settings.minimap).toBe(false)
    expect(set('hero ai').settings.skin).toBe('ai')
    expect(set('reset').settings).toEqual(DEFAULTS)
  })
  test('what it cannot read changes nothing, and says what it takes', () => {
    for (const words of ['rows 13', 'size 9', 'size 0.6', 'map maybe', 'hero dragon', 'wobble 3', '']) {
      const out = applySetting(DEFAULTS, words.split(' '))
      expect(out.settings).toBe(DEFAULTS)
      expect(out.message.length).toBeGreaterThan(0)
    }
  })
  test('the figures the settings offer are the ones the board can draw', () => {
    expect(SKINS.map(s => s.id)).toEqual(SKIN_IDS)
  })
})
