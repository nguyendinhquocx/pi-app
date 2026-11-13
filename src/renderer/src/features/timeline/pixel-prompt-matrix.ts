/** 7 行 × 12 列：terminal prompt 的 `>` + `_` 像素标记。 */
export const PIXEL_PROMPT_ROWS = [
  '100000000000',
  '010000000000',
  '001000000000',
  '000100000000',
  '001000000000',
  '010000000000',
  '100000111111',
] as const

export const PIXEL_PROMPT_COLS = PIXEL_PROMPT_ROWS[0].length
export const PIXEL_PROMPT_ROW_COUNT = PIXEL_PROMPT_ROWS.length

export type PixelCell = { key: string; on: boolean; delayMs: number }

export function buildPixelPromptCells(): PixelCell[] {
  const cells: PixelCell[] = []
  let idx = 0
  for (let r = 0; r < PIXEL_PROMPT_ROW_COUNT; r++) {
    const row = PIXEL_PROMPT_ROWS[r]
    for (let c = 0; c < PIXEL_PROMPT_COLS; c++) {
      const on = row[c] === '1'
      cells.push({
        key: `${r}-${c}`,
        on,
        delayMs: on ? idx++ * 26 : 0,
      })
    }
  }
  return cells
}

export function pixelPromptAssembleMs(cellCountOn: number): number {
  return cellCountOn * 26 + 380
}
