import { describe, expect, test } from 'bun:test'
import { bandRows, DEFAULTS, MAX_ROWS, MIN_ROWS, readSettings, wantScale } from '../hooks/game/settings.ts'

describe('settings', () => {
  test('a stored value is read back, and anything unrecognised falls back', () => {
    expect(readSettings(undefined)).toEqual(DEFAULTS)
    expect(readSettings({ rows: 16, scale: 2, minimap: false, skin: 'ai' })).toEqual({ rows: 16, scale: 2, minimap: false, skin: 'ai' })
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
  test('auto asks for as much size as the band allows', () => {
    expect(wantScale({ ...DEFAULTS, scale: 'auto' })).toBeGreaterThan(3)
    expect(wantScale({ ...DEFAULTS, scale: 2 })).toBe(2)
  })
})

// the stage's scale is worked out in the board, next to the drawing it is for
import { stageScale } from '../hooks/boards/dungeon.tsx'

describe('the stage scale', () => {
  test('a whole number when one fits, otherwise as much of the height as there is', () => {
    // a band with room for two whole hero heights draws at ×2
    expect(stageScale(16, 32, 4)).toBe(2)
    expect(stageScale(16, 40, 4)).toBe(2)
    expect(stageScale(16, 48, 4)).toBe(3)
    // a band too short for ×2 still fills: the hero grows to the height it has
    expect(stageScale(16, 22, 4)).toBeCloseTo(22 / 16, 6)
    // what the player asked for wins when it fits
    expect(stageScale(16, 40, 1)).toBe(1)
    expect(stageScale(16, 40, 2)).toBe(2)
    // asked for more than fits: as much as fits
    expect(stageScale(16, 20, 3)).toBeCloseTo(20 / 16, 6)
    // a sprite taller than the stage is shrunk, as before
    expect(stageScale(24, 12, 4)).toBe(0.5)
  })
})

import { applySetting, SKIN_IDS } from '../hooks/game/settings.ts'
import { SKINS } from '../hooks/boards/dungeon.tsx'

describe('/kaneed set', () => {
  const set = (words: string) => applySetting(DEFAULTS, words.split(' '))
  test('each setting can be named from the keyboard', () => {
    expect(set('rows 16').settings.rows).toBe(16)
    expect(set('rows auto').settings.rows).toBe('auto')
    expect(set('size 2').settings.scale).toBe(2)
    expect(set('size ×3').settings.scale).toBe(3)
    expect(set('map off').settings.minimap).toBe(false)
    expect(set('hero ai').settings.skin).toBe('ai')
    expect(set('reset').settings).toEqual(DEFAULTS)
  })
  test('what it cannot read changes nothing, and says what it takes', () => {
    for (const words of ['rows 13', 'size 9', 'map maybe', 'hero dragon', 'wobble 3', '']) {
      const out = applySetting(DEFAULTS, words.split(' '))
      expect(out.settings).toBe(DEFAULTS)
      expect(out.message.length).toBeGreaterThan(0)
    }
  })
  test('the figures the settings offer are the ones the board can draw', () => {
    expect(SKINS.map(s => s.id)).toEqual(SKIN_IDS)
  })
})
