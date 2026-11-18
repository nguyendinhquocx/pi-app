import { ATTACHMENT_MAX_BYTES } from '@shared/remote'

/**
 * Attachment upload (spec T4 / spec global): prompt-only, ≤ 10 MiB, base64 over the typed RPC.
 * No clipboard drop-parsing, no filesystem picker — the user selects one file at a time.
 */

export type PreparedAttachment = {
  name: string
  sha256: string
  size: number
  mime: string
  base64: string
}

export class AttachmentTooLargeError extends Error {
  constructor(readonly size: number) {
    super(`attachment is ${size} bytes; limit is ${ATTACHMENT_MAX_BYTES} (10 MiB), prompt-only`)
    this.name = 'AttachmentTooLargeError'
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/** Validate + encode one File for `attachment.upload`. Throws AttachmentTooLargeError. */
export async function prepareAttachment(file: File): Promise<PreparedAttachment> {
  if (file.size > ATTACHMENT_MAX_BYTES) throw new AttachmentTooLargeError(file.size)
  if (file.size === 0) throw new Error('attachment is empty')
  const bytes = new Uint8Array(await readFileBytes(file))
  return {
    name: file.name.slice(0, 255),
    size: file.size,
    mime: file.type || 'application/octet-stream',
    sha256: await sha256Hex(bytes),
    base64: bytesToBase64(bytes),
  }
}

/** File.arrayBuffer() is missing in older engines/jsdom — FileReader path covers those. */
async function readFileBytes(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'))
    reader.readAsArrayBuffer(file)
  })
}

/** Read a file via the picker and hand it to `prepareAttachment` (prompt-only entry point). */
export async function pickAndPrepare(): Promise<PreparedAttachment | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      resolve(prepareAttachment(file).catch((e) => {
        throw e
      }))
    }
    input.click()
  })
}
