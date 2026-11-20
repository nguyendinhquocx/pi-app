import { ipcClient } from '@renderer/lib/ipc-client'
import { normalizeSessionFileKey } from '@renderer/lib/session-file-key'
import type { TimelineItem } from '@renderer/stores/ui-store-types'
import { useUIStore } from '@renderer/stores/ui-store'
import {
  isTimelineCatchUpComplete,
  planTimelineTailFetch,
  TIMELINE_FETCH_PAGE_SIZE,
  type TimelineSyncCursor,
} from '@shared/session-timeline-sync-plan'
import { projectTimelineItems } from '@shared/timeline-projection'
import { sanitizeHistoryTimeline } from '@renderer/lib/timeline-dedupe'
import { spliceFreshDiskTail } from '@renderer/lib/merge-live-history-timeline'
import { normalizeSessionFileKey, sessionFilesEqual } from '@renderer/lib/session-file-key'
import { getSessionNavigationToken, isSessionNavigationCurrent } from '@renderer/lib/session-navigation'
import { isTimelineNearBottom } from '@renderer/features/timeline/timeline-follow-scroll'
import { getTimelineScrollEl } from '@renderer/features/timeline/timeline-scroll-bridge'
import { requestTimelineBottomAnchor } from '@renderer/features/timeline/timeline-bottom-anchor'

export type HistoryPage = {
  items: TimelineItem[]
  sourceCount: number
  totalCount: number
  error?: string
}

const OLDER_PAGE_TTL_MS = 90_000
const olderPageCache = new Map<string, { page: HistoryPage; at: number }>()
const inflightOlderPages = new Map<string, Promise<HistoryPage>>()

function olderPageKey(sessionFile: string, offset: number, limit: number): string {
  const norm = normalizeSessionFileKey(sessionFile) || sessionFile
  return `${norm}|${offset}|${limit}`
}

export function clearTimelineHistoryPageCache(sessionFile?: string): void {
  if (!sessionFile) {
    olderPageCache.clear()
    return
  }
  const prefix = `${normalizeSessionFileKey(sessionFile) || sessionFile}|`
  for (const k of olderPageCache.keys()) {
    if (k.startsWith(prefix)) olderPageCache.delete(k)
  }
}

export async function fetchTimelineHistoryPage(
  sessionFile: string,
  offset: number,
  limit: number = TIMELINE_FETCH_PAGE_SIZE,
): Promise<HistoryPage> {
  if (offset > 0) {
    const key = olderPageKey(sessionFile, offset, limit)
    const hit = olderPageCache.get(key)
    if (hit && Date.now() - hit.at < OLDER_PAGE_TTL_MS) {
      return hit.page
    }
    const existing = inflightOlderPages.get(key)
    if (existing) return existing
    const req = fetchPage(sessionFile, offset, limit)
      .then((page) => {
        if (!page.error && page.items.length > 0) {
          olderPageCache.set(key, { page, at: Date.now() })
        }
        return page
      })
      .finally(() => {
        if (inflightOlderPages.get(key) === req) inflightOlderPages.delete(key)
      })
    inflightOlderPages.set(key, req)
    return req
  }
  return fetchPage(sessionFile, offset, limit)
}

/** Silently warm the next older disk page into memory without mutating UI store or DOM. */
export function prefetchTimelineHistoryPage(
  sessionFile: string,
  offset: number,
  limit: number = TIMELINE_FETCH_PAGE_SIZE,
): void {
  if (offset <= 0) return
  const key = olderPageKey(sessionFile, offset, limit)
  const hit = olderPageCache.get(key)
  if (hit && Date.now() - hit.at < OLDER_PAGE_TTL_MS) return
  if (inflightOlderPages.has(key)) return
  void fetchTimelineHistoryPage(sessionFile, offset, limit).catch(() => {})
}

async function fetchPage(sessionFile: string, offset: number, limit: number): Promise<HistoryPage> {
  const workspaceId = useUIStore.getState().currentWorkspace || undefined
  const res = await ipcClient.invoke('session.getMessages', { sessionFile, workspaceId, offset, limit })
  const err = (res as { error?: string })?.error
  if (err) return { items: [], sourceCount: 0, totalCount: 0, error: err }
  const sourceItems = (res?.items || []) as TimelineItem[]
  const sourceCount =
    typeof (res as { sourceCount?: number })?.sourceCount === 'number'
      ? (res as { sourceCount: number }).sourceCount
      : sourceItems.length
  const items = sanitizeHistoryTimeline(sourceItems)
  const totalCount = typeof res?.totalCount === 'number' ? res.totalCount : sourceCount
  return {
    items: projectTimelineItems(items) as TimelineItem[],
    sourceCount,
    totalCount,
  }
}

export function lastSessionEntryId(items: TimelineItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const id = items[i].sessionEntryId
    if (id) return id
  }
  return null
}

export async function syncAuthoritativeTail(sessionFile: string, limit = TIMELINE_FETCH_PAGE_SIZE): Promise<{
  tail: TimelineItem[]
  cursor: TimelineSyncCursor
}> {
  const plan = planTimelineTailFetch(limit)
  const page = await fetchPage(sessionFile, 0, plan.limit)
  const tail = page.items
  const cursor: TimelineSyncCursor = {
    totalCount: page.totalCount,
    loadedOffsetFromEnd: Math.min(page.totalCount, page.sourceCount),
    loadedThroughEntryId: lastSessionEntryId(tail),
  }
  return { tail, cursor }
}

/** Prepend older JSONL pages until loadedOffsetFromEnd reaches totalCount. */
export async function catchUpAuthoritativeAfter(
  sessionFile: string,
  cursor: TimelineSyncCursor,
  limit = TIMELINE_FETCH_PAGE_SIZE,
  initialTail?: TimelineItem[],
): Promise<{ tail: TimelineItem[]; cursor: TimelineSyncCursor; error?: string }> {
  let totalCount = cursor.totalCount
  let loadedOffset = cursor.loadedOffsetFromEnd
  let tail: TimelineItem[] = initialTail ? [...initialTail] : []
  let error: string | undefined

  if (!initialTail) {
    const boot = await fetchPage(sessionFile, 0, Math.max(limit, loadedOffset || limit))
    if (boot.error) return { tail: [], cursor, error: boot.error }
    totalCount = boot.totalCount
    tail = boot.items
    loadedOffset = boot.sourceCount
  }

  for (let guard = 0; guard < 32; guard++) {
    if (isTimelineCatchUpComplete({ totalCount, loadedOffsetFromEnd: loadedOffset, error })) break
    const page = await fetchPage(sessionFile, loadedOffset, limit)
    if (page.error) {
      error = page.error
      break
    }
    totalCount = Math.max(totalCount, page.totalCount)
    if (page.sourceCount === 0) break
    tail = [...page.items, ...tail]
    loadedOffset += page.sourceCount
  }

  return {
    tail,
    cursor: {
      totalCount,
      loadedOffsetFromEnd: Math.min(totalCount, loadedOffset),
      loadedThroughEntryId: lastSessionEntryId(tail) ?? cursor.loadedThroughEntryId,
    },
    error,
  }
}

/** Tail page + older pages for open-session (totalCount > limit). */
export async function loadAuthoritativeForOpen(
  sessionFile: string,
  pageSize = TIMELINE_FETCH_PAGE_SIZE,
): Promise<{ items: TimelineItem[]; totalCount: number; cursor: TimelineSyncCursor; error?: string }> {
  const initial = await syncAuthoritativeTail(sessionFile, pageSize)
  if (isTimelineCatchUpComplete(initial.cursor)) {
    return { items: initial.tail, totalCount: initial.cursor.totalCount, cursor: initial.cursor }
  }
  const caught = await catchUpAuthoritativeAfter(
    sessionFile,
    initial.cursor,
    pageSize,
    initial.tail,
  )
  return {
    items: caught.tail,
    totalCount: caught.cursor.totalCount,
    cursor: caught.cursor,
    error: caught.error,
  }
}

// ── External session slim reload ─────────────────────────────────────────────

export type ExternalSlimReloadResult = {
  applied: boolean
  followed: boolean
  reason?: 'not-visible' | 'local-turn-active' | 'error'
  error?: string
}

/**
 * A local/slot turn owns the timeline tail: an external merge would flash/duplicate it.
 */
function externalReloadSuppressed(store: {
  historySessionFile: string | null
  streamingAssistantId: string | null
  optimisticPendingUserText: string | null
  agentTurnBootstrapping: boolean
  sessionRuntimeRunning: Record<string, boolean>
  workerLiveSnapshot: { sessionFile: string | null; status: string }
}): boolean {
  if (store.streamingAssistantId != null || store.optimisticPendingUserText != null || store.agentTurnBootstrapping) return true
  const file = store.historySessionFile
  if (!file) return true
  // `sessionRuntimeRunning` is also set from this external event for the UI label, so it cannot
  // distinguish an external TUI turn from a local slot. Use slot-specific activity signals below.
  const snap = store.workerLiveSnapshot
  return !!(snap.sessionFile && snap.status === 'running' && sessionFilesEqual(snap.sessionFile, file))
}

/**
 * External session update (file written outside the app): merge ONLY the fresh disk tail into
 * the loaded timeline by entry anchor. Pages already loaded stay; the scroll anchor holds
 * (near bottom → follow through the real anchor controller; mid-timeline → untouched); and
 * runState / sidebar / session tree / composer are never touched. Deliberately NOT
 * `reloadCurrentSessionData()` — that forces bottom, drops pages and resets runState.
 */
export async function slimReloadExternalUpdate(sessionFile: string): Promise<ExternalSlimReloadResult> {
  // Generation token: an overlapping reload (fetch #1 still in flight when #2 fires) must not
  // let the stale fetch win via last-finisher-wins ordering.
  const gen = ++externalReloadGeneration
  const store = useUIStore.getState()
  if (!store.historySessionFile || !sessionFilesEqual(store.historySessionFile, sessionFile)) {
    return { applied: false, followed: false, reason: 'not-visible' }
  }
  if (externalReloadSuppressed(store)) {
    return { applied: false, followed: false, reason: 'local-turn-active' }
  }
  const navToken = getSessionNavigationToken()
  try {
    const { tail, cursor } = await syncAuthoritativeTail(sessionFile)
    const now = useUIStore.getState()
    if (gen !== externalReloadGeneration) return { applied: false, followed: false }
    if (!isSessionNavigationCurrent(navToken) || !sessionFilesEqual(now.historySessionFile, sessionFile)) {
      return { applied: false, followed: false, reason: 'not-visible' }
    }
    if (!tail.length) return { applied: false, followed: false }

    const scrollEl = getTimelineScrollEl()
    const nearBottom = scrollEl ? isTimelineNearBottom(scrollEl) : true
    const merged = spliceFreshDiskTail(now.timelineItems, tail)
    // A structural change (TUI rewind/branch switch) has no shared anchor: the merged list IS the
    // whole loaded history now — carrying the old loadedCount would make items.length diverge.
    const structural = merged.prefixCount === 0
    const delta = Math.max(0, cursor.totalCount - now.historyTotalCount)
    useUIStore.setState({
      timelineItems: merged.items,
      historyTotalCount: Math.max(now.historyTotalCount, cursor.totalCount),
      historyLoadedCount: structural
        ? merged.items.length
        : Math.min(
          Math.max(now.historyTotalCount, cursor.totalCount),
          now.historyLoadedCount + delta,
        ),
    })
    if (nearBottom) requestTimelineBottomAnchor('resume-stream')
    return { applied: true, followed: nearBottom }
  } catch (e: unknown) {
    return { applied: false, followed: false, reason: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}

const pendingExternalReloads = new Map<string, ReturnType<typeof setTimeout>>()
let externalReloadGeneration = 0

/** Coalesce bursts of external file events into one reload 1.5s after the last one. */
export function scheduleExternalSlimReload(sessionFile: string, delayMs = 1500): void {
  const key = normalizeSessionFileKey(sessionFile)
  const existing = pendingExternalReloads.get(key)
  if (existing) clearTimeout(existing)
  pendingExternalReloads.set(
    key,
    setTimeout(() => {
      pendingExternalReloads.delete(key)
      void slimReloadExternalUpdate(sessionFile)
    }, delayMs),
  )
}