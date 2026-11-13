package dev.pi.remote.sync

import dev.pi.remote.protocol.OpenResult
import dev.pi.remote.protocol.TimelineReset
import dev.pi.remote.protocol.TurnPatch
import dev.pi.remote.protocol.TurnPatchEvent
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
    private val buffered = mutableListOf<TurnPatch>()
    private var overflowed = false

    init {
        require(sessionKey.isNotBlank()) { "sessionKey must be canonical and non-empty" }
        require(canonicalSessionKey(sessionKey) == sessionKey) { "sessionKey must be canonical" }
        require(maxBufferedPatches > 0)
    }

    fun current(): SessionTimeline? = timeline

    /** Seed from a local cache without replacing a newer live state. */
    fun seed(cached: SessionTimeline) {
        if (canonicalSessionKey(cached.sessionKey) != sessionKey) return
        val normalized = cached.copy(sessionKey = sessionKey)
        val current = timeline
        if (current == null || current.epoch != normalized.epoch || normalized.seq >= current.seq) {
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
            overflowed = false
        }
        if (epoch != null && timeline != null && timeline?.epoch != epoch) {
            // The old epoch is not safe for applying current events; retain it only for display
            // until the replacement snapshot is ready.
            buffered.clear()
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
            overflowed = false
            return SessionSyncResult.NeedsResync(timeline, "branch reset")
        }

        val current = timeline
        val shouldBuffer = activeOpen != null || current == null ||
            (eventEpoch != null && current.epoch != eventEpoch)
        if (shouldBuffer) {
            if (!overflowed) {
                if (buffered.size + event.patches.size > maxBufferedPatches) {
                    buffered.clear()
                    overflowed = true
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
                return SessionSyncResult.NeedsResync(opened.timeline, "gap inside session.open replay")
            }
        }

        if (overflowed) {
            timeline = base
            buffered.clear()
            overflowed = false
            activeOpen = null
            return SessionSyncResult.NeedsResync(base, "live patch buffer overflow")
        }

        return when (val drained = TurnStore.applyAll(base, buffered.toList())) {
            is ApplyResult.Applied -> {
                timeline = drained.timeline
                buffered.clear()
                activeOpen = null
                expectedEpoch = response.epoch
                SessionSyncResult.Applied(drained.timeline)
            }
            is ApplyResult.Gap -> {
                timeline = drained.timeline
                buffered.clear()
                activeOpen = null
                expectedEpoch = response.epoch
                SessionSyncResult.NeedsResync(drained.timeline, "gap while draining live patches")
            }
        }
    }

    /** Finish a failed open without discarding a same-epoch cache or buffered patch evidence. */
    fun failOpen(openId: Long): SessionSyncResult {
        if (activeOpen != openId || generation != openId) return SessionSyncResult.StaleOpen
        activeOpen = null
        val current = timeline
        return if (current == null || buffered.isNotEmpty() || overflowed) {
            SessionSyncResult.NeedsResync(current, "session.open failed with unsynchronized state")
        } else {
            SessionSyncResult.Applied(current)
        }
    }

    private fun applyTo(current: SessionTimeline, patches: List<TurnPatch>): SessionSyncResult =
        when (val applied = TurnStore.applyAll(current, patches)) {
            is ApplyResult.Applied -> {
                timeline = applied.timeline
                SessionSyncResult.Applied(applied.timeline)
            }
            is ApplyResult.Gap -> {
                timeline = applied.timeline
                SessionSyncResult.NeedsResync(applied.timeline, "live patch sequence gap")
            }
        }

    companion object {
        const val DEFAULT_MAX_BUFFERED_PATCHES = 2_000
    }
}
