// Rows of cells as styled spans: one per run of cells sharing a style. Pure, so `bun test` runs it.

export type Cell = [glyph: string, fg?: string, bg?: string, dim?: boolean, bold?: boolean]

// The spans one row may take on average. The engine refuses a Client's tree over 100000 characters,
// and every span costs its style on top of its text, so a picture gets a budget of spans in all,
// handed to the rows that need them (share), and less when it is wide (withinSize).
export const MAX_RUNS = 64
// what a drawing of the stage may serialize to: the tree's cap, less room for the header and status line
export const STAGE_CHARS = 90_000

/**
 * The rows drawn with a budget of spans that keeps them within `limit` characters as serialized:
 * `rows * MAX_RUNS` first, then less, each try measured, never guessed. A wide stage has more text
 * per row and so less room for styles.
 */
export function withinSize<T>(rows: number, draw: (budget: number) => T, limit = STAGE_CHARS): T {
  let budget = rows * MAX_RUNS
  let drawn = draw(budget)
  for (let tries = 0; tries < 6 && JSON.stringify(drawn).length > limit && budget > rows; tries++) {
    budget = Math.max(rows, Math.floor(budget * 0.7))
    drawn = draw(budget)
  }
  return drawn
}

const blank = (text: string) => /^ *$/.test(text)
const cellsIn = (text: string) => [...text].length

/**
 * The runs of `cells`, losing nothing. A blank shows only its background, so it joins the run
 * beside it whenever the backgrounds match, whatever the foregrounds: the mortar between the wall's
 * bricks does not break the row into a run per brick.
 */
export function join(cells: readonly Cell[]): Cell[] {
  const out: Cell[] = []
  for (const c of cells) {
    const last = out[out.length - 1]
    if (last && last[1] === c[1] && last[2] === c[2] && last[3] === c[3] && last[4] === c[4]) last[0] += c[0]
    else if (last && last[2] === c[2] && blank(c[0])) last[0] += c[0]
    else if (last && last[2] === c[2] && blank(last[0])) out[out.length - 1] = [last[0] + c[0], c[1], c[2], c[3], c[4]]
    else out.push([c[0], c[1], c[2], c[3], c[4]])
  }
  return out
}

/**
 * `runs` cut to at most `max` by folding the shortest run into a neighbour, one at a time: what is
 * lost is a speck of a few cells, never a band of colour. The neighbour's style wins, but a run with
 * no foreground takes the speck's, so a `▀` is never drawn in the terminal's default colour.
 */
export function fit(runs: readonly Cell[], max: number): Cell[] {
  const out: Cell[] = runs.map(r => [r[0], r[1], r[2], r[3], r[4]])
  const limit = Math.max(1, max)
  while (out.length > limit) {
    let at = 0
    let size = Infinity
    for (let i = 0; i < out.length; i++) {
      const n = cellsIn(out[i][0])
      if (n < size) { size = n; at = i }
    }
    const speck = out[at]
    const prev = out[at - 1]
    const next = out[at + 1]
    // into the side sharing its background when one does, else the one before
    const into = !prev ? at + 1 : next && next[2] === speck[2] && prev[2] !== speck[2] ? at + 1 : at - 1
    const host = out[into]
    const text = into < at ? host[0] + speck[0] : speck[0] + host[0]
    out[into] = [text, host[1] ?? speck[1], host[2] ?? speck[2], host[3], host[4]]
    out.splice(at, 1)
  }
  return out
}

/** One row's runs within `max` (the average share, for a picture of one row). */
export const runs = (cells: readonly Cell[], max = MAX_RUNS): Cell[] => fit(join(cells), max)

/**
 * Every row's runs, `total` spans shared out among them: a row that needs few gives what it does
 * not use to the rows that need more, so only a picture busier than `total` as a whole loses detail.
 */
export function share(rows: readonly (readonly Cell[])[], total = rows.length * MAX_RUNS): Cell[][] {
  const joined = rows.map(join)
  const need = joined.reduce((n, r) => n + r.length, 0)
  if (need <= total) return joined
  // water-filling: the least needy rows take what they need, the rest split what is left evenly
  const order = joined.map((r, i) => i).sort((a, b) => joined[a].length - joined[b].length)
  const allow: number[] = Array.from({ length: rows.length }, () => 0)
  let left = total
  order.forEach((row, k) => {
    const even = Math.floor(left / (order.length - k))
    allow[row] = Math.max(1, Math.min(joined[row].length, even))
    left -= allow[row]
  })
  return joined.map((r, i) => (r.length > allow[i] ? fit(r, allow[i]) : r))
}
