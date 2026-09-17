// What the player has chosen about the band: how tall it is, how large the figures are drawn,
// whether the minimap shows, and which hero stands on the stage. The hooks module keeps these in
// its store (so they outlive the session) and hands them to the board with every draw.

export type Settings = { rows: number | 'auto'; scale: number | 'auto'; minimap: boolean; skin: string }

export const DEFAULTS: Settings = { rows: 'auto', scale: 'auto', minimap: true, skin: 'kaneed' }

// the band is never shorter than this, whatever is asked, or the stage has no room to draw
export const MIN_ROWS = 9
export const MAX_ROWS = 22
export const ROW_CHOICES: (number | 'auto')[] = ['auto', 12, 16, 20, 22]
// the drawn art is as large as the stage ever draws it; the choices below only make it smaller
export const SCALE_CHOICES: (number | 'auto')[] = ['auto', 1, 0.75, 0.5]
// the figures the board can draw, in the order the settings screen cycles them
export const SKIN_IDS = ['kaneed', 'ai', 'midori', 'murasaki', 'kin', 'fallback']

const isChoice = (v: unknown, choices: (number | 'auto')[]) => choices.some(c => c === v)

// a stored value, read back as settings: anything unrecognised falls back to the default, so an
// older store (or a hand-edited one) cannot break the band
export function readSettings(v: unknown): Settings {
  const raw = (typeof v === 'object' && v !== null ? v : {}) as Partial<Settings>
  return {
    rows: isChoice(raw.rows, ROW_CHOICES) ? raw.rows as number | 'auto' : DEFAULTS.rows,
    scale: isChoice(raw.scale, SCALE_CHOICES) ? raw.scale as number | 'auto' : DEFAULTS.scale,
    minimap: typeof raw.minimap === 'boolean' ? raw.minimap : DEFAULTS.minimap,
    skin: typeof raw.skin === 'string' && raw.skin ? raw.skin : DEFAULTS.skin,
  }
}

// how many rows the band takes: what was asked for, inside what the terminal has room for
export const bandRows = (settings: Settings, maxRows: number) => {
  const room = Math.max(MIN_ROWS, Math.min(MAX_ROWS, maxRows - 1))
  return settings.rows === 'auto' ? room : Math.max(MIN_ROWS, Math.min(settings.rows, room))
}

// the size the stage draws at, never above 1: the sprites are drawn at the size they were made,
// and a shorter band (or a smaller choice) takes them down from there
export const wantScale = (settings: Settings) => (settings.scale === 'auto' ? 1 : settings.scale)

// `/kaneed set <what> <value>`: the same settings from the keyboard, for a terminal without a
// pointer. Unreadable input changes nothing and says what it takes.
export function applySetting(settings: Settings, words: string[]): { settings: Settings; message: string } {
  const [what, value] = [words[0] ?? '', words.slice(1).join(' ').trim()]
  const no = (message: string) => ({ settings, message })
  const onOff = (v: string) => (/^(on|表示|yes|true)$/i.test(v) ? true : /^(off|非表示|no|false)$/i.test(v) ? false : null)
  switch (what) {
    case 'rows': case 'height': case '高さ': {
      const rows = value === 'auto' || value === '自動' ? 'auto' : Number(value)
      if (!isChoice(rows, ROW_CHOICES)) return no(`帯の高さは ${ROW_CHOICES.join(' / ')} から選ぶ（例: /kaneed set rows 16）`)
      return { settings: { ...settings, rows: rows as number | 'auto' }, message: `帯の高さを ${rows === 'auto' ? '自動' : `${rows} 行`} にした` }
    }
    case 'size': case 'scale': case '大きさ': {
      // 0.75 and 75% and 75 all name the same size
      const raw = value.replace(/^[x×]/i, '').replace(/%$/, '')
      const num = Number(raw)
      const scale = value === 'auto' || value === '自動' ? 'auto' : num > 1 ? num / 100 : num
      if (!isChoice(scale, SCALE_CHOICES)) return no(`大きさは 自動 / 1 / 0.75 / 0.5 から選ぶ（例: /kaneed set size 0.5）`)
      return { settings: { ...settings, scale: scale as number | 'auto' }, message: `キャラクターの大きさを ${scale === 'auto' ? '自動' : `×${scale}`} にした` }
    }
    case 'map': case 'minimap': case 'ミニマップ': {
      const on = onOff(value)
      if (on === null) return no('ミニマップは on / off で指定する（例: /kaneed set map off）')
      return { settings: { ...settings, minimap: on }, message: `ミニマップを${on ? '表示' : '非表示'}にした` }
    }
    case 'hero': case 'skin': case '主人公': {
      if (!SKIN_IDS.includes(value)) return no(`主人公は ${SKIN_IDS.join(' / ')} から選ぶ（例: /kaneed set hero ai）`)
      return { settings: { ...settings, skin: value }, message: `主人公を ${value} にした` }
    }
    case 'reset': case '初期化':
      return { settings: { ...DEFAULTS }, message: '設定を初期値に戻した' }
    default:
      return no('設定できるのは rows / size / map / hero / reset（例: /kaneed set rows 16）')
  }
}
