import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildPixelPromptCells,
  PIXEL_PROMPT_COLS,
  PIXEL_PROMPT_ROWS,
  pixelPromptAssembleMs,
} from './pixel-prompt-matrix'

describe('terminal prompt loading mark', () => {
  it('uses the same 7×12 prompt matrix in session loading and the boot splash', () => {
    expect(PIXEL_PROMPT_ROWS).toEqual([
      '100000000000',
      '010000000000',
      '001000000000',
      '000100000000',
      '001000000000',
      '010000000000',
      '100000111111',
    ])
    expect(PIXEL_PROMPT_ROWS.every((row) => row.length === PIXEL_PROMPT_COLS)).toBe(true)

    const html = readFileSync(join(process.cwd(), 'src/renderer/index.html'), 'utf8')
    const inlineRows = html.match(/var rows = (\[[^;]+\]);/)?.[1]
    expect(inlineRows).toBeDefined()
    expect(JSON.parse(inlineRows!.replace(/'/g, '"'))).toEqual(PIXEL_PROMPT_ROWS)
  })

  it('assembles the prompt in row-major order and only delays lit cells', () => {
    const cells = buildPixelPromptCells()
    const lit = cells.filter((cell) => cell.on)
    expect(cells).toHaveLength(7 * 12)
    expect(lit).toHaveLength(13)
    expect(lit.map((cell) => cell.delayMs)).toEqual(lit.map((_, index) => index * 26))
    expect(pixelPromptAssembleMs(lit.length)).toBe(718)
  })
})
