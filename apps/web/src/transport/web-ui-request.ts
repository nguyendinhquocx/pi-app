import type { UiRequest } from '@shared/remote'

/**
 * Unknown custom kinds use a distinct internal discriminator so they cannot masquerade as one
 * of the shared, strictly validated adapters. `rawPayload` remains untrusted and is redacted / 
 * bounded before rendering.
 */
export type UnknownCustomUiRequest = {
  id: string
  sessionKey: string
  method: 'custom'
  kind: 'unknown_custom'
  rawKind: string
  extensionName: string
  toolName: string
  rawPayload: Record<string, unknown>
}

export type WebUiRequest = UiRequest | UnknownCustomUiRequest

export function normalizeUnknownCustomUiRequest(raw: unknown): UnknownCustomUiRequest | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const req = raw as Record<string, unknown>
  if (req.method !== 'custom') return null
  if (typeof req.id !== 'string' || req.id.length === 0 || req.id.length > 160) return null
  if (typeof req.sessionKey !== 'string' || req.sessionKey.length === 0 || req.sessionKey.length > 4096) return null
  if (typeof req.kind !== 'string' || req.kind.length === 0 || req.kind.length > 120) return null
  return {
    id: req.id,
    sessionKey: req.sessionKey,
    method: 'custom',
    kind: 'unknown_custom',
    rawKind: req.kind,
    extensionName: typeof req.extensionName === 'string' ? req.extensionName.slice(0, 120) : typeof req.extension === 'string' ? req.extension.slice(0, 120) : req.kind,
    toolName: typeof req.toolName === 'string' ? req.toolName.slice(0, 120) : req.kind,
    rawPayload: req,
  }
}
