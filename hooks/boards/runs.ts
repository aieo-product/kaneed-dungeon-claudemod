// A row of cells as styled spans: one per run of cells sharing a style. Pure, so `bun test` runs it.

export type Cell = [glyph: string, fg?: string, bg?: string, dim?: boolean, bold?: boolean]

// The spans one row may take. The engine refuses a Client's tree over 100000 characters, and every
// span costs its style on top of its text, so the budget is per row and fixed.
export const MAX_RUNS = 64

const blank = (text: string) => /^ *$/.test(text)

/**
 * The runs of `cells`. A blank shows only its background, so it joins the run beside it whenever the
 * backgrounds match, whatever the foregrounds: the mortar between the wall's bricks no longer
 * breaks the row into a run per brick. Over `maxRuns`, runs fold pairwise, keeping the first run's
 * style but never its lack of a foreground: a `▀` is never drawn in the terminal's default colour
 * (issue #47).
 */
export function runs(cells: readonly Cell[], maxRuns = MAX_RUNS): Cell[] {
  let out: Cell[] = []
  for (const c of cells) {
    const last = out[out.length - 1]
    if (last && last[1] === c[1] && last[2] === c[2] && last[3] === c[3] && last[4] === c[4]) last[0] += c[0]
    else if (last && last[2] === c[2] && blank(c[0])) last[0] += c[0]
    else if (last && last[2] === c[2] && blank(last[0])) out[out.length - 1] = [last[0] + c[0], c[1], c[2], c[3], c[4]]
    else out.push([c[0], c[1], c[2], c[3], c[4]])
  }
  while (out.length > Math.max(1, maxRuns)) {
    const folded: Cell[] = []
    for (let i = 0; i < out.length; i += 2) {
      const a = out[i]
      const b = out[i + 1]
      folded.push(b ? [a[0] + b[0], a[1] ?? b[1], a[2] ?? b[2], a[3], a[4]] : a)
    }
    out = folded
  }
  return out
}
