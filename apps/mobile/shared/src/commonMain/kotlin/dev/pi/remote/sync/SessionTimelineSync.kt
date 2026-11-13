package dev.pi.remote.sync

import dev.pi.remote.protocol.OpenResult
import dev.pi.remote.protocol.TimelineReset
import dev.pi.remote.protocol.TurnPatch
import dev.pi.remote.protocol.TurnPatchEvent
import dev.pi.remote.protocol.UiDismiss
import dev.pi.remote.protocol.UiRequest
import dev.pi.remote.protocol.canonicalSessionKey

/** Result of reconciling one session's snapshot and ordered live patches. */
sealed interface SessionSyncResult {
    data class Applied(val timeline: SessionTimeline) : SessionSyncResult
    data class Buffered(val patchCount: Int) : SessionSyncResult
    data class NeedsResync(val timeline: SessionTimeline?, val reason: String) : SessionSyncResult
    data object StaleOpen : SessionSyncResult
    data object Ignored : SessionSyncResult
}

/**
 * Serializable reducer for one remote session. The repository calls its methods under a short
 * synchronized section; network RPCs happen outside that section. While an open RPC is in flight, live patches are
 * buffered, then reconciled against the response cursor so an event that races the response cannot
 * disappear or overwrite a newer timeline.
 */
class SessionTimelineSync(
    val sessionKey: String,
    private val maxBufferedPatches: Int = DEFAULT_MAX_BUFFERED_PATCHES,
) {
    private var timeline: SessionTimeline? = null
    private var generation = 0L
    private var activeOpen: Long? = null
    private var expectedEpoch: String? = null
    private sealed interface UiPatch {
        data class Add(val request: UiRequest) : UiPatch
        data class Remove(val id: String) : UiPatch
    }

    private val buffered = mutableListOf<TurnPatch>()
    private val bufferedUi = mutableListOf<UiPatch>()
    private var overflowed = false
    private var needsResync = true

    init {
        require(sessionKey.isNotBlank()) { "sessionKey must be canonical and non-empty" }
        require(canonicalSessionKey(sessionKey) == sessionKey) { "sessionKey must be canonical" }
        require(maxBufferedPatches > 0)
    }

    fun current(): SessionTimeline? = timeline

    /** A cached timeline is displayable but not writable until a live open reconciles it. */
    fun isReady(epoch: String?): Boolean {
        val current = timeline ?: return false
        return activeOpen == null && !needsResync && (epoch == null || current.epoch == epoch)
    }

    /** Seed from a local cache without replacing a newer live state. */
    fun seed(cached: SessionTimeline) {
        if (canonicalSessionKey(cached.sessionKey) != sessionKey) return
        val normalized = cached.copy(sessionKey = sessionKey)
        val current = timeline
        if (current == null || current.epoch != normalized.epoch || normalized.seq >= current.seq) {
            if (current == null || current.epoch != normalized.epoch) needsResync = true
            timeline = normalized
        }
    }

    /** Begin a snapshot/replay request. Keep a same-epoch cache visible while it loads. */
    fun beginOpen(epoch: String?, fresh: Boolean = false): Long {
        generation += 1
        activeOpen = generation
        expectedEpoch = epoch
        if (fresh && overflowed) {
            // A fresh full snapshot is the only safe recovery after buffer overflow.
            buffered.clear()
            bufferedUi.clear()
            overflowed = false
        }
        if (epoch != null && timeline != null && timeline?.epoch != epoch) {
            // The old epoch is not safe for applying current events; retain it only for display
            // until the replacement snapshot is ready.
            buffered.clear()
            bufferedUi.clear()
            overflowed = false
        }
        return generation
    }

    /** Apply or buffer one ordered event. Call [beginOpen] after NeedsResync. */
    fun onPatch(event: TurnPatchEvent, eventEpoch: String?): SessionSyncResult {
        if (canonicalSessionKey(event.sessionKey) != sessionKey) return SessionSyncResult.Ignored
        if (expectedEpoch != null && eventEpoch != null && expectedEpoch != eventEpoch) {
            return SessionSyncResult.Ignored
        }
        if (event.patches.any { it is TimelineReset }) {
            buffered.clear()
            bufferedUi.clear()
            overflowed = false
            needsResync = true
            return SessionSyncResult.NeedsResync(timeline, "branch reset")
        }

        val current = timeline
        val epochMismatch = current != null && eventEpoch != null && current.epoch != eventEpoch
        val shouldBuffer = activeOpen != null || current == null || epochMismatch
        if (current == null || epochMismatch) needsResync = true
        if (shouldBuffer) {
            if (!overflowed) {
                if (buffered.size + bufferedUi.size + event.patches.size > maxBufferedPatches) {
                    buffered.clear()
                    bufferedUi.clear()
                    overflowed = true
                    needsResync = true
                } else {
                    buffered.addAll(event.patches)
                }
            }
            return if (overflowed) {
                SessionSyncResult.NeedsResync(current, "live patch buffer overflow")
            } else if (current == null && activeOpen == null) {
                SessionSyncResult.NeedsResync(null, "patch arrived before a timeline was opened")
            } else {
                SessionSyncResult.Buffered(buffered.size)
            }
        }

        return applyTo(current, event.patches)
    }

    fun onUiRequest(request: UiRequest): SessionSyncResult {
        if (canonicalSessionKey(request.sessionKey) != sessionKey) return SessionSyncResult.Ignored
        val current = timeline
        if (activeOpen != null || current == null) {
            if (buffered.size + bufferedUi.size >= maxBufferedPatches) {
                buffered.clear()
                bufferedUi.clear()
                overflowed = true
                needsResync = true
                return SessionSyncResult.NeedsResync(current, "live event buffer overflow")
            }
            bufferedUi += UiPatch.Add(request)
            return if (current == null && activeOpen == null) {
                SessionSyncResult.NeedsResync(null, "UI request arrived before a timeline was opened")
            } else {
                SessionSyncResult.Buffered(buffered.size + bufferedUi.size)
            }
        }
        timeline = TurnStore.addUi(current, request)
        return SessionSyncResult.Applied(timeline!!)
    }

    fun onUiDismiss(dismiss: UiDismiss): SessionSyncResult {
        if (canonicalSessionKey(dismiss.sessionKey) != sessionKey) return SessionSyncResult.Ignored
        val current = timeline
        if (activeOpen != null || current == null) {
            if (buffered.size + bufferedUi.size >= maxBufferedPatches) {
                buffered.clear()
                bufferedUi.clear()
                overflowed = true
                needsResync = true
                return SessionSyncResult.NeedsResync(current, "live event buffer overflow")
            }
            bufferedUi += UiPatch.Remove(dismiss.id)
            return if (current == null && activeOpen == null) {
                SessionSyncResult.NeedsResync(null, "UI dismiss arrived before a timeline was opened")
            } else {
                SessionSyncResult.Buffered(buffered.size + bufferedUi.size)
            }
        }
        timeline = TurnStore.removeUi(current, dismiss.id)
        return SessionSyncResult.Applied(timeline!!)
    }

    /** Install the latest open response, then drain live patches that arrived while it was loading. */
    fun completeOpen(openId: Long, response: OpenResult): SessionSyncResult {
        if (activeOpen != openId || generation != openId) return SessionSyncResult.StaleOpen
        val normalized = response.copy(sessionKey = sessionKey)
        val opened = TurnStore.fromOpenResult(timeline, normalized)
        val base = when (opened) {
            is ApplyResult.Applied -> opened.timeline
            is ApplyResult.Gap -> {
                timeline = opened.timeline
                activeOpen = null
                needsResync = true
                return SessionSyncResult.NeedsResync(opened.timeline, "gap inside session.open replay")
            }
        }

        if (overflowed) {
            timeline = base
            buffered.clear()
            bufferedUi.clear()
            overflowed = false
            activeOpen = null
            needsResync = true
            return SessionSyncResult.NeedsResync(base, "live event buffer overflow")
        }

        return when (val drained = TurnStore.applyAll(base, buffered.toList())) {
            is ApplyResult.Applied -> {
                var merged = drained.timeline
                for (patch in bufferedUi) merged = applyUi(merged, patch)
                timeline = merged
                buffered.clear()
                bufferedUi.clear()
                activeOpen = null
                expectedEpoch = response.epoch
                needsResync = false
                SessionSyncResult.Applied(merged)
            }
            is ApplyResult.Gap -> {
                timeline = drained.timeline
                buffered.clear()
                bufferedUi.clear()
                activeOpen = null
                expectedEpoch = response.epoch
                needsResync = true
                SessionSyncResult.NeedsResync(drained.timeline, "gap while draining live patches")
            }
        }
    }

    /** Finish a failed open without discarding a same-epoch cache or buffered patch evidence. */
    fun failOpen(openId: Long): SessionSyncResult {
        if (activeOpen != openId || generation != openId) return SessionSyncResult.StaleOpen
        activeOpen = null
        needsResync = true
        val current = timeline
        return if (current == null || buffered.isNotEmpty() || bufferedUi.isNotEmpty() || overflowed) {
            SessionSyncResult.NeedsResync(current, "session.open failed with unsynchronized state")
        } else {
            SessionSyncResult.Applied(current)
        }
    }

    private fun applyUi(timeline: SessionTimeline, patch: UiPatch): SessionTimeline = when (patch) {
        is UiPatch.Add -> TurnStore.addUi(timeline, patch.request)
        is UiPatch.Remove -> TurnStore.removeUi(timeline, patch.id)
    }

    private fun applyTo(current: SessionTimeline, patches: List<TurnPatch>): SessionSyncResult =
        when (val applied = TurnStore.applyAll(current, patches)) {
            is ApplyResult.Applied -> {
                timeline = applied.timeline
                SessionSyncResult.Applied(applied.timeline)
            }
            is ApplyResult.Gap -> {
                timeline = applied.timeline
                needsResync = true
                SessionSyncResult.NeedsResync(applied.timeline, "live patch sequence gap")
            }
        }

    companion object {
        const val DEFAULT_MAX_BUFFERED_PATCHES = 2_000
    }
}
