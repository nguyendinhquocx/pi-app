// Owner-conflict classification across the worker RPC boundary (SPEC-2026-11-16-li-web T2).
//
// The worker replies carry a `code` field when an owner-protocol check failed
// (writer_conflict / owner_unavailable). Main-side mutating entry points convert that
// into a typed error so every caller — desktop IPC handlers, the remote gateway port and
// SessionHub — surfaces `writer_conflict` instead of a generic failure.

export type WorkerOwnerCode = 'writer_conflict' | 'owner_unavailable'

export class WorkerOwnerConflictError extends Error {
  readonly code: WorkerOwnerCode
  readonly ownerPid?: number

  constructor(code: WorkerOwnerCode, message: string, ownerPid?: number) {
    super(message)
    this.name = 'WorkerOwnerConflictError'
    this.code = code
    if (ownerPid !== undefined) this.ownerPid = ownerPid
  }
}

type WorkerReplyLike = { type?: unknown; code?: unknown; error?: unknown; ownerPid?: unknown }

/** True when the worker reply is a typed owner-protocol failure. */
export function isWorkerOwnerConflict(reply: WorkerReplyLike): boolean {
  return (
    reply?.type === 'error' &&
    (reply.code === 'writer_conflict' || reply.code === 'owner_unavailable')
  )
}

/** Convert an owner-conflict worker reply into the typed main-process error. */
export function workerOwnerConflictFromReply(reply: WorkerReplyLike): WorkerOwnerConflictError {
  const code = reply.code === 'owner_unavailable' ? 'owner_unavailable' : 'writer_conflict'
  const message = typeof reply.error === 'string' && reply.error ? reply.error : code
  const ownerPid = typeof reply.ownerPid === 'number' ? reply.ownerPid : undefined
  return new WorkerOwnerConflictError(code, message, ownerPid)
}

/**
 * Throw for failed worker replies: owner-protocol failures become the typed error,
 * anything else a plain Error with the worker's message.
 */
export function throwIfWorkerReplyError(reply: WorkerReplyLike, fallback: string): void {
  if (reply?.type !== 'error') return
  if (isWorkerOwnerConflict(reply)) throw workerOwnerConflictFromReply(reply)
  const message = typeof reply.error === 'string' && reply.error ? reply.error : fallback
  throw new Error(message)
}
