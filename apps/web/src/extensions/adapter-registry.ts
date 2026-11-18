import type { WebUiRequest } from '../transport/web-ui-request'

/**
 * Built-in dialogs and two known adapter kinds render natively. Unknown custom kinds fall back
 * to a warning card. Raw payloads are bounded and credential-like values redacted.
 */
export type AdapterKind = 'select' | 'confirm' | 'input' | 'editor' | 'notify' | 'ask_user_question' | 'image_review' | 'fallback'
export type AdapterDescriptor = { kind: AdapterKind; extension: string; native: boolean }

export const KNOWN_EXTENSIONS: Record<string, string> = {
  ask_user_question: 'pi-ask / agent-browser',
  image_review: 'pi-image-gen',
}

export function resolveAdapter(request: WebUiRequest): AdapterDescriptor {
  if (request.method !== 'custom') return { kind: request.method, extension: 'LiX built-in', native: true }
  if (request.kind === 'ask_user_question') return { kind: 'ask_user_question', extension: KNOWN_EXTENSIONS.ask_user_question, native: true }
  if (request.kind === 'image_review') {
    const browserAddress = /^https?:\/\//i.test(request.image) || request.image.startsWith('data:') || request.image.startsWith('blob:')
    if (browserAddress) return { kind: 'image_review', extension: KNOWN_EXTENSIONS.image_review, native: true }
    // Host-local filesystem paths are not valid browser URLs and no image relay RPC exists in
    // T2. Do not pretend a broken <img> is a native adapter; show the truthful fallback instead.
    return { kind: 'fallback', extension: KNOWN_EXTENSIONS.image_review, native: false }
  }
  if (request.kind === 'unknown_custom') return { kind: 'fallback', extension: request.extensionName, native: false }
  return { kind: 'fallback', extension: 'unknown-extension', native: false }
}

const SECRET_KEY = /(secret|password|token|api.?key|credential|authorization|private.?key)/i
function redactAndBound(value: unknown, depth: number): unknown {
  if (depth > 5) return '[depth limit]'
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => redactAndBound(item, depth + 1))
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      output[key] = SECRET_KEY.test(key) ? '[redacted]' : key.toLowerCase() === 'image' ? '[image omitted]' : redactAndBound(item, depth + 1)
    }
    return output
  }
  return value
}

export function fallbackRawPayload(request: WebUiRequest, cap = 2000): string {
  const source = request.method === 'custom' && request.kind === 'unknown_custom' ? request.rawPayload : request
  const json = JSON.stringify(redactAndBound(source, 0), null, 2)
  return json.length > cap ? `${json.slice(0, cap)}\n… (truncated ${json.length - cap} chars)` : json
}

export const FALLBACK_NOTICE = 'Chưa hỗ trợ trên Web'
