/**
 * Terminal hardening (spec T4): xterm.js renders host PTY output but clipboard writeback from
 * the host stream is OFF — OSC 52 ("set clipboard") sequences are stripped before they reach
 * the terminal. This is the single choke point every terminal.data chunk passes through.
 *
 * OSC 52 shapes: ESC ] 52 ; <pc> ; <base64> <ST | BEL>
 * We strip the whole sequence regardless of payload validity (fail-closed, not parse-dependent).
 */

const OSC = 0x1b
const BEL = 0x07

/** Strip OSC-52 clipboard-write sequences from a PTY chunk (binary-safe). */
export function stripOsc52(data: string): string {
  let out = ''
  let i = 0
  while (i < data.length) {
    const code = data.charCodeAt(i)
    if (code === OSC && data[i + 1] === ']') {
      // Find the string terminator: BEL or ESC \ (ST).
      let j = i + 2
      let terminated = false
      while (j < data.length) {
        if (data.charCodeAt(j) === BEL) {
          j++
          terminated = true
          break
        }
        if (data.charCodeAt(j) === OSC && data[j + 1] === '\\') {
          j += 2
          terminated = true
          break
        }
        j++
      }
      const payload = data.slice(i + 2, terminated ? j - (data.charCodeAt(j - 1) === BEL ? 1 : 2) : j)
      if (payload.startsWith('52')) {
        // OSC 52 → dropped entirely (never reaches xterm → no clipboard write from host).
        i = j
        continue
      }
      // Other OSC sequences pass through untouched.
      out += data.slice(i, j)
      i = j
      continue
    }
    out += data[i]
    i++
  }
  return out
}

/** bytes → chunked write through the filter; keeps the API obvious for the Terminal component. */
export function createTerminalWriter(write: (s: string) => void): (chunk: string) => void {
  return (chunk: string) => write(stripOsc52(chunk))
}
