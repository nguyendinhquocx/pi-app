import { fileURLToPath } from 'node:url'
import { preparePiCliEntry } from '../worker-cli-entry.js'
import { widenHttpConnectTimeout } from '../worker-http-connect.js'
import { errorMessage } from '@shared/error-message'
import { normalizeUserMessageDisplayText } from '@shared/worker-message'
import type { WorkerIncomingMessage } from '../worker-port-types.js'
import type { ExtensionUIResponse } from '../desktop-ui-bridge.js'
import type { WorkerReply } from '../worker-handler-types.js'
import {
  st,
  initSession,
  baseEvent,
  beginRunIdentity,
  emit,
  currentSessionModelKey,
} from '../worker-runtime.js'
import { claimOwnerHandoffFromEnv, enableOwnerStrictMode, classifyOwnerError, resolveOwnerProtocol } from '../worker-owner-protocol.js'

export async function handleInit(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
        try {
          console.log('[Worker] Initializing st.session for:', msg.cwd)
          st.activeSdkPath = typeof msg.sdkPath === 'string' && msg.sdkPath ? msg.sdkPath : null
          let sdkFallback = false
          try {
            if (st.activeSdkPath) {
              const { isAbsolute } = await import('node:path')
              const { pathToFileURL } = await import('node:url')
              if (isAbsolute(st.activeSdkPath)) {
                st.sdk = await import(pathToFileURL(st.activeSdkPath).href)
              } else {
                st.sdk = await import(st.activeSdkPath)
              }
            } else {
              st.sdk = await import('@earendil-works/pi-coding-agent')
            }
          } catch (e: unknown) {
            console.error('[Worker] Dynamic import SDK failed, fallback to builtin:', errorMessage(e))
            st.activeSdkPath = null
            st.sdk = await import('@earendil-works/pi-coding-agent')
            sdkFallback = true
          }
          if (!st.sdk) throw new Error('SDK load failed')
          let resolvedEntry: string | null = null
          try {
            resolvedEntry = st.activeSdkPath ?? fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
            await preparePiCliEntry(resolvedEntry)
            widenHttpConnectTimeout(resolvedEntry)
          } catch (e) {
            console.warn('[Worker] Could not resolve Pi CLI entry:', errorMessage(e))
          }
          if (!st.sharedEventBus) st.sharedEventBus = st.sdk.createEventBus()
          // Owner protocol (T1 SDK): claim a pending handoff BEFORE the session opens, then
          // flip this cross-client worker into strict writer enforcement.
          await claimOwnerHandoffFromEnv(resolvedEntry)
          const ownerProtocolVersion = await enableOwnerStrictMode(resolvedEntry)
          try {
            await initSession(String(msg.cwd || ''))
          } catch (e) {
            const classified = classifyOwnerError(e)
            if (classified.code) {
              reply({
                type: 'error',
                error: classified.message,
                code: classified.code,
                ...(classified.ownerPid !== undefined ? { ownerPid: classified.ownerPid } : {}),
              })
              return
            }
            throw e
          }
          if (resolvedEntry) {
            const globalCfg = (st.session?.settingsManager as { getGlobalSettings?: () => Record<string, unknown> } | undefined)?.getGlobalSettings?.()
            widenHttpConnectTimeout(resolvedEntry, globalCfg?.httpConnectTimeoutMs)
          }
          console.log('[Worker] Init done, sessionId:', st.currentSessionId)
          const ownerProtocol = await resolveOwnerProtocol(resolvedEntry)
          const ownerEpoch = typeof st.session?.getOwnerStatus === 'function' ? (st.session.getOwnerStatus() as { ownerEpoch?: number }).ownerEpoch : undefined
          reply({ type: 'init-done', sessionId: st.currentSessionId, model: currentSessionModelKey(), thinkingLevel: st.session?.thinkingLevel, sdkFallback, ownerProtocol: ownerProtocol.version ?? undefined, ownerEpoch })
        } catch (e: unknown) {
          console.error('[Worker] Init FAILED:', errorMessage(e), e instanceof Error ? e.stack : '')
          reply({ type: 'error', error: `Init failed: ${errorMessage(e)}`, stack: e instanceof Error ? e.stack : undefined })
        }
        return
}


export async function handlePrompt(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
        const promptSession = st.session
        if (!promptSession) { reply({ type: 'error', error: 'No session' }); return }
        const promptText = String(msg.text ?? '').trim()
        const slashMatch = promptText.match(/^(\/\S+)/)
        if (slashMatch) {
          emit({
            ...baseEvent(),
            type: 'slash',
            command: slashMatch[1],
            status: 'dispatched',
            text: '已发送给 pi 执行',
          })
        }
        st.promptSent = true
        // 在首个 stream 事件前就标 busy，避免切会话/evict 误杀；streamingBehavior 须用标记前的状态
        const alreadyStreaming = promptSession.isStreaming || st.agentTurnActive
        if (!alreadyStreaming) {
          beginRunIdentity()
          st.agentTurnActive = true
          st.promptPreflightActive = true
          st.abortAfterPreflight = false
          emit({ ...baseEvent(), type: 'run', phase: 'started' })
        }
        reply({ type: 'prompt-done' })
        void (async () => {
          try {
            const extra = msg.options as Parameters<typeof promptSession.prompt>[1]
            const merged =
              alreadyStreaming && !extra?.streamingBehavior
                ? { ...extra, streamingBehavior: 'followUp' as const }
                : extra
            await promptSession.prompt(promptText, merged)
            if (!alreadyStreaming && st.promptPreflightActive) {
              st.promptPreflightActive = false
              st.abortAfterPreflight = false
              st.agentTurnActive = false
              emit({ ...baseEvent(), type: 'run', phase: 'idle' })
            }
            if (slashMatch) {
              emit({
                ...baseEvent(),
                type: 'slash',
                command: slashMatch[1],
                status: 'ok',
                text: '命令已执行（详见下方助手/工具输出）',
              })
            }
          } catch (e: unknown) {
            console.error('[Worker] prompt failed:', e)
            const errText = errorMessage(e)
            if (st.promptPreflightActive) {
              st.promptPreflightActive = false
              st.abortAfterPreflight = false
              st.agentTurnActive = false
              emit({
                ...baseEvent(),
                type: 'agent_error',
                text: errText,
                kind: 'error',
                stopReason: 'error',
              })
              emit({ ...baseEvent(), type: 'run', phase: 'failed' })
            }
            if (slashMatch) {
              emit({
                ...baseEvent(),
                type: 'slash',
                command: slashMatch[1],
                status: 'error',
                text: `执行失败: ${errText}`,
              })
            }
          }
        })()
        return
}


export async function handleAbort(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
  const session = st.session
  if (!session) {
    reply({ type: 'abort-done', wasRunning: false, stopped: true })
    return
  }
  // Truthful abort: report what was actually running BEFORE the stop attempt and what
  // still is afterwards (no ambiguous success — spec T2).
  const wasRunning = !!(st.agentTurnActive || session.isStreaming)
  try {
    session.clearQueue()
    // prompt() is still in preflight (input handlers, routing): pi has no run to abort yet and
    // would start one right after. Abort that run as soon as it starts.
    if (st.promptPreflightActive) st.abortAfterPreflight = true
    await session.abort()
    const stopped = !session.isStreaming && !st.agentTurnActive && !st.abortAfterPreflight
    reply({ type: 'abort-done', wasRunning, stopped })
  } catch (error: unknown) {
    console.error('[Worker] abort failed:', error)
    reply({ type: 'error', error: `abort failed: ${errorMessage(error)}` })
  }
}


export async function handleSteer(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
        const session = st.session
        if (!session) {
          // No ambiguous success: steering without an owned session is a typed failure.
          reply({ type: 'error', error: 'no owned session for steer', code: 'no_session' })
          return
        }
        try {
          const disposition = await session.steer(String(msg.text ?? ''))
          reply({ type: 'steer-done', disposition })
        } catch (error: unknown) {
          const classified = classifyOwnerError(error)
          if (classified.code) {
            reply({ type: 'error', error: classified.message, code: classified.code, ...(classified.ownerPid !== undefined ? { ownerPid: classified.ownerPid } : {}) })
            return
          }
          reply({ type: 'error', error: `steer failed: ${errorMessage(error)}` })
        }
        return
}


export async function handleFollowup(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
        const session = st.session
        if (!session) { reply({ type: 'error', error: 'No owned session for followUp', code: 'no_session' }); return }
        try {
          const disposition = await session.followUp(String(msg.text ?? ''))
          reply({ type: 'followUp-done', disposition })
        } catch (error: unknown) {
          const classified = classifyOwnerError(error)
          if (classified.code) {
            reply({ type: 'error', error: classified.message, code: classified.code, ...(classified.ownerPid !== undefined ? { ownerPid: classified.ownerPid } : {}) })
            return
          }
          console.error('[Worker] followUp failed:', error)
          const errText = errorMessage(error)
          reply({ type: 'error', error: `followUp failed: ${errText}` })
          emit({
            ...baseEvent(),
            type: 'agent_error',
            text: errText,
            kind: 'error',
            stopReason: 'error',
          })
        }
        return
}


export async function handleClearqueue(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
        if (!st.session) { reply({ type: 'clearQueue-done', steering: [], followUp: [] }); return }
        const cleared = st.session.clearQueue()
        reply({
          type: 'clearQueue-done',
          steering: (cleared.steering || []).map(normalizeUserMessageDisplayText),
          followUp: (cleared.followUp || []).map(normalizeUserMessageDisplayText),
        })
        return
}


export async function handleExtensionUiResponse(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
        st.uiBridge?.handleExtensionUIResponse(msg.response as ExtensionUIResponse)
        reply({ type: 'extension-ui-response-done' })
        return
}


export async function handleExtensionUiCancel(
  msg: WorkerIncomingMessage,
  reply: WorkerReply,
): Promise<void> {
  st.uiBridge?.handleExtensionUiCancel(msg.cancel as { id?: string; reason?: string })
  reply({ type: 'extension-ui-cancel-done' })
}


export async function handleDispose(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
        st.uiBridge?.dispose()
        st.uiBridge = null
        // Abort in-flight turn before dispose so pi can flush a terminal assistant entry
        // (empty/incomplete leaf) rather than leaving the session unrewindable after force-quit.
        try {
          const streaming = !!(st.agentTurnActive || st.session?.isStreaming)
          if (streaming) {
            try {
              st.session?.clearQueue?.()
            } catch {
              /* ignore */
            }
            if (st.session) await st.session.abort()
          }
        } catch (e) {
          console.error('[Worker] abort-on-dispose failed:', e)
        }
        st.agentTurnActive = false
        st.promptPreflightActive = false
        st.abortAfterPreflight = false
        if (st.unsubscribe) { st.unsubscribe(); st.unsubscribe = null }
        try {
          st.session?.dispose()
        } catch (e) {
          console.error('[Worker] session.dispose failed:', e)
        }
        st.session = null
        st.modelRuntime = null
        st.runtime = null
        reply({ type: 'dispose-done' })
        return
}


export async function handlePing(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
        reply({ type: 'pong' })
        return
}

/** Owner-protocol status snapshot for the host gate (getOwnerStatus from the T1 SDK). */
export async function handleOwnerStatus(msg: WorkerIncomingMessage, reply: WorkerReply): Promise<void> {
  const session = st.session
  let status: Record<string, unknown> | null = null
  if (session && typeof session.getOwnerStatus === 'function') {
    try {
      status = session.getOwnerStatus() as unknown as Record<string, unknown>
    } catch {
      status = null
    }
  }
  const protocol = await resolveOwnerProtocol(st.activeSdkPath)
  reply({ type: 'owner-status', status, protocol: protocol.version ?? null })
  return
}

