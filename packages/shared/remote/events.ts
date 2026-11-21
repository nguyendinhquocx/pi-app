import { z } from 'zod'
import { SessionSummarySchema, TurnPatchSchema } from './timeline'
import { UiDismissSchema, UiRequestSchema } from './ui'

/** Server → client events (`k: "evt"`). */
export const REMOTE_EVENTS = {
  'sessions.update': z.object({ sessions: z.array(SessionSummarySchema), removed: z.array(z.string()).optional() }).strict(),
  'turn.patch': z.object({ sessionKey: z.string(), patches: z.array(TurnPatchSchema).min(1) }).strict(),
  'ui.request': UiRequestSchema,
  'ui.dismiss': UiDismissSchema,
  'settings.changed': z
    .object({ key: z.enum(['cacheWarming', 'capabilities', 'purge', 'projects', 'models', 'rewound']), sessionKey: z.string().optional() })
    .strict(),
  'host.notice': z.object({ level: z.enum(['info', 'warning', 'error']), text: z.string() }).strict(),
  /** Host PTY output chunk. Delivered only to the connection that opened the terminal. */
  'terminal.data': z.object({ terminalId: z.string(), data: z.string() }).strict(),
  /** Host PTY exited (remote client should mark the terminal dead). */
  'terminal.exit': z.object({ terminalId: z.string(), code: z.number().int().optional() }).strict(),
} as const

export type RemoteEvent = keyof typeof REMOTE_EVENTS
export type EventPayload<E extends RemoteEvent> = z.infer<(typeof REMOTE_EVENTS)[E]>
