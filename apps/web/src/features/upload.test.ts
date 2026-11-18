// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { ATTACHMENT_MAX_BYTES } from '@shared/remote'
import { prepareAttachment, AttachmentTooLargeError, bytesToBase64, sha256Hex } from './upload'

/**
 * Spec T4 acceptance: attachment upload stays prompt-only and ≤ 10 MiB (shared constant).
 */

function makeFile(size: number, name = 'note.txt', type = 'text/plain'): File {
  const bytes = new Uint8Array(size).fill(65)
  return new File([bytes], name, { type })
}

describe('attachment upload (spec: ≤10 MiB, prompt-only)', () => {
  it('accepts a file at the shared 10 MiB limit', async () => {
    const file = makeFile(ATTACHMENT_MAX_BYTES)
    const prepared = await prepareAttachment(file)
    expect(prepared.size).toBe(ATTACHMENT_MAX_BYTES)
    expect(prepared.name).toBe('note.txt')
    expect(prepared.mime).toBe('text/plain')
    expect(prepared.base64.length).toBeGreaterThan(0)
  })

  it('rejects anything over the shared limit with a typed error', async () => {
    await expect(prepareAttachment(makeFile(ATTACHMENT_MAX_BYTES + 1))).rejects.toBeInstanceOf(AttachmentTooLargeError)
    await expect(prepareAttachment(makeFile(20 * 1024 * 1024))).rejects.toThrow('10 MiB')
  })

  it('rejects empty files', async () => {
    await expect(prepareAttachment(makeFile(0))).rejects.toThrow('empty')
  })

  it('sha256 is stable and base64 round-trips', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const h1 = await sha256Hex(bytes)
    const h2 = await sha256Hex(bytes)
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
    const b64 = bytesToBase64(bytes)
    const bin = atob(b64)
    expect([...bin].map((c) => c.charCodeAt(0))).toEqual([1, 2, 3, 4, 5])
  })

  it('unknown mime falls back to octet-stream', async () => {
    const file = new File([new Uint8Array(4).fill(1)], 'blob')
    const prepared = await prepareAttachment(file)
    expect(prepared.mime).toBe('application/octet-stream')
  })
})
