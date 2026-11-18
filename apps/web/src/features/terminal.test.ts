import { describe, expect, it } from 'vitest'
import { stripOsc52, createTerminalWriter } from './terminal'

/**
 * Spec T4: terminal xterm.js with OSC 52 clipboard write disabled from the host stream — the
 * filter is the single choke point between terminal.data events and the xterm write.
 */

const ESC = '\x1b'
const BEL = '\x07'
const ST = '\x1b\\'

describe('OSC 52 clipboard-write strip (spec T4 acceptance)', () => {
  it('strips OSC 52 with BEL terminator', () => {
    const chunk = `${ESC}]52;c;aGVsbG8=${BEL}after`
    expect(stripOsc52(chunk)).toBe('after')
  })

  it('strips OSC 52 with ST terminator', () => {
    const chunk = `${ESC}]52;cp;b64${ST}tail`
    expect(stripOsc52(chunk)).toBe('tail')
  })

  it('strips OSC 52 with empty payload (clipboard clear form)', () => {
    expect(stripOsc52(`${ESC}]52;c;${BEL}x`)).toBe('x')
    expect(stripOsc52(`${ESC}]52;${BEL}x`)).toBe('x')
  })

  it('strips unbalanced OSC 52 (fail-closed, not parse-dependent)', () => {
    expect(stripOsc52(`${ESC}]52;c;no-terminator-ever`)).toBe('')
  })

  it('keeps ordinary ANSI colors and cursor moves untouched', () => {
    const chunk = `${ESC}[31mred${ESC}[0m${ESC}[2Jplain`
    expect(stripOsc52(chunk)).toBe(chunk)
  })

  it('keeps non-52 OSC sequences (e.g. OSC 0 set title)', () => {
    const chunk = `${ESC}]0;window title${BEL}body`
    expect(stripOsc52(chunk)).toBe(chunk)
  })

  it('passes plain text byte-identical', () => {
    expect(stripOsc52('hello $ prompt\r\n')).toBe('hello $ prompt\r\n')
  })

  it('writer pipes through the filter', () => {
    const written: string[] = []
    const write = createTerminalWriter((s) => written.push(s))
    write(`${ESC}]52;c;zz${BEL}visible`)
    expect(written).toEqual(['visible'])
  })

  it('mixed chunk: clipboard probe embedded in output is removed, rest intact', () => {
    const chunk = `$ echo hi\r\n${ESC}]52;c; leak${BEL}done\r\n`
    expect(stripOsc52(chunk)).toBe('$ echo hi\r\ndone\r\n')
  })
})
