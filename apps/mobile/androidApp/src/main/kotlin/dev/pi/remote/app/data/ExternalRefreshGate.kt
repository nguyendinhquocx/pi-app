package dev.pi.remote.app.data

/**
 * Decides when a `sessions.update` row for the open session warrants a full `reopen(fresh = true)`
 * pull. Live patches are the primary path; this gate is the fallback for sessions running outside
 * the LiX slot pool, whose files can change without any patch reaching the ring.
 *
 * Pure and injectable: no repository/network access, only decision state, and time comes from
 * [now] so tests drive the clock. The repository feeds per-session facts (last summary stamp,
 * last patch time, last reset time) and acts on the decision.
 *
 * Fingerprint: the wire schema for `sessions.update` rows is strict and carries no turn anchor,
 * so the closest stable per-turn identity is `status` + `preview` (see [summaryFingerprint]) —
 * preview changes whenever a turn completes even when the status stays idle. The gate remembers
 * the fingerprint the local timeline last reflected: summaries observed while patches flow, while
 * the host streams, or right after a reset are absorbed (the primary/resync path is already
 * refreshing the view), and a fresh summary that differs from the baseline triggers reopen at
 * most once per [minIntervalMs]. The first observation of a session only seeds the baseline, so
 * opening a session never fires a redundant reopen.
 */
internal class ExternalRefreshGate(
    private val minIntervalMs: Long = DEFAULT_MIN_INTERVAL_MS,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private class State {
        /** Last summary fingerprint the local timeline is known to reflect. */
        var reflected: String? = null
        var lastReopenAt: Long? = null
    }

    private val states = HashMap<String, State>()

    /**
     * Returns true when the caller should `reopen(fresh = true)` for [key]. [knownUpdatedAt] is
     * the previous summary stamp for this session (null before the first update); [lastPatchAt]
     * and [lastResetAt] are the last live patch / reset times (null when never).
     */
    @Synchronized
    fun shouldReopen(
        key: String,
        fingerprint: String,
        updatedAt: Long,
        knownUpdatedAt: Long?,
        lastPatchAt: Long?,
        lastResetAt: Long?,
        running: Boolean,
    ): Boolean {
        val at = now()
        val state = states.getOrPut(key) { State() }
        val stale = knownUpdatedAt != null && updatedAt <= knownUpdatedAt
        val patchLive = lastPatchAt != null && at - lastPatchAt < minIntervalMs
        val resetRecent = lastResetAt != null && at - lastResetAt < minIntervalMs

        // Patches flowing, host streaming, or a resync just ran: the view is being refreshed by
        // the primary path — absorb the summary, never reopen on top of it. Stale rows are not
        // absorbed: they carry nothing new and must not poison the baseline.
        if (patchLive || resetRecent || running) {
            if (!stale) state.reflected = fingerprint
            return false
        }
        if (stale) return false
        val reflected = state.reflected
        if (reflected == null) {
            state.reflected = fingerprint
            return false
        }
        if (reflected == fingerprint) return false
        val lastReopenAt = state.lastReopenAt
        if (lastReopenAt != null && at - lastReopenAt < minIntervalMs) return false
        state.reflected = fingerprint
        state.lastReopenAt = at
        return true
    }

    /** Drops remembered state for one session (host switch hygiene). */
    @Synchronized
    fun forget(key: String) {
        states.remove(key)
    }

    @Synchronized
    fun clear() {
        states.clear()
    }

    companion object {
        const val DEFAULT_MIN_INTERVAL_MS = 30_000L

        /**
         * Stable identity of one summary row: status plus preview (last answer line / pending
         * question / failure text). A completed turn changes at least one of the two.
         */
        fun summaryFingerprint(status: String?, preview: String?): String =
            "${status.orEmpty()}|${preview.orEmpty()}"
    }
}
