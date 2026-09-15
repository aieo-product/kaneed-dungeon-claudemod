// Text charts for the dashboard: sparklines and horizontal bars made of block characters, and the
// number formats beside them. Pure strings, so the tests can read them; the board colours them.

const SPARK = '▁▂▃▄▅▆▇█'
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

// the display width of a string in terminal cells: CJK and full-width forms take two
export const cellWidth = (text: string) => {
  let w = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ? 2 : 1
  }
  return w
}

// pads (or clips) to exactly `width` cells
export const padCells = (text: string, width: number) => {
  let out = ''
  let w = 0
  for (const ch of text) {
    const cw = cellWidth(ch)
    if (w + cw > width) break
    out += ch
    w += cw
  }
  return out + ' '.repeat(width - w)
}

// a series squeezed into `width` points: the last `width` as they are, or buckets of the whole
// series averaged (`mean`) or summed (`sum`) when it is longer
export function resample(values: readonly number[], width: number, mode: 'last' | 'mean' | 'sum' = 'last'): number[] {
  if (width <= 0) return []
  if (values.length <= width) return [...values]
  if (mode === 'last') return values.slice(-width)
  const out: number[] = []
  const size = values.length / width
  for (let i = 0; i < width; i++) {
    const bucket = values.slice(Math.floor(i * size), Math.max(Math.floor(i * size) + 1, Math.floor((i + 1) * size)))
    const sum = bucket.reduce((a, v) => a + v, 0)
    out.push(mode === 'sum' ? sum : sum / bucket.length)
  }
  return out
}

// one block per value, scaled between `min` (default: the smallest, or 0 when all are positive)
// and the largest; an empty series is blank and a flat one sits on the lowest block
export function spark(values: readonly number[], width: number, opts: { mode?: 'last' | 'mean' | 'sum'; min?: number; max?: number } = {}): string {
  const pts = resample(values, width, opts.mode)
  if (!pts.length) return ' '.repeat(Math.max(0, width))
  const lo = opts.min ?? Math.min(0, ...pts)
  const hi = opts.max ?? Math.max(...pts)
  const line = pts.map(v => {
    if (hi <= lo) return SPARK[0]
    const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)))
    return SPARK[Math.round(t * (SPARK.length - 1))]
  }).join('')
  return line + ' '.repeat(Math.max(0, width - pts.length))
}

// a bar `value / max` of `width` cells, drawn to an eighth of a cell; a non-zero value shows at least a sliver
export function hbar(value: number, max: number, width: number): string {
  if (width <= 0) return ''
  const eighths = max > 0 ? Math.round(Math.min(1, Math.max(0, value / max)) * width * 8) : 0
  const shown = value > 0 ? Math.max(1, eighths) : 0
  const full = Math.floor(shown / 8)
  const bar = '█'.repeat(full) + EIGHTHS[shown % 8]
  return bar + ' '.repeat(Math.max(0, width - cellWidth(bar)))
}

// 950, 1.2k, 34k, 1.5M
export function compact(n: number): string {
  const a = Math.abs(n)
  if (a < 1000) return String(Math.round(n))
  if (a < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (a < 1_000_000) return `${Math.round(n / 1000)}k`
  if (a < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return `${Math.round(n / 1_000_000)}M`
}

// 45秒, 12分, 1時間05分
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}分`
  return `${Math.floor(m / 60)}時間${String(m % 60).padStart(2, '0')}分`
}

export const signed = (n: number) => (n > 0 ? `+${n}` : String(n))
