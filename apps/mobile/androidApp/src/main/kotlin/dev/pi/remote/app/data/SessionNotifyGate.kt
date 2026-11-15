package dev.pi.remote.app.data

/**
 * Decides which `sessions.update` transitions post a notification. Pure and injectable like
 * [ExternalRefreshGate]: no Android types, and time comes from [now] so tests drive the clock.
 *
 * Rules (mirrors the desktop's external-completion watcher):
 * - Only observed transitions notify: `running → terminal` (completion) or `→ needsInput`
 *   (question). The first sighting of a session only seeds the baseline — no notify.
 * - The open, on-screen session is the user's live view; the in-app timeline already covers it,
 *   so it never notifies ([openAndVisible]).
 * - Completions honor the Settings toggle ([completionsEnabled]); questions always pass through
 *   (they block the run, and the pre-toggle path delivered them too).
 * - Dedupe by `status@updatedAt` per session: every observed transition is consumed once — the
 *   same summary row replayed (reconnect refresh, hub re-push) never fires twice, whether it
 *   notified or was suppressed (live view / toggle off). A genuinely new completion carries a
 *   new stamp and notifies again.
 */
internal class SessionNotifyGate {
    private val notified = HashMap<String, String>()

    @Synchronized
    fun shouldNotify(
        key: String,
        wasStatus: String?,
        status: String,
        updatedAt: Long,
        openAndVisible: Boolean,
        completionsEnabled: Boolean,
    ): Boolean {
        val settled = wasStatus == "running" && status != "running"
        val asks = wasStatus != null && status == "needsInput" && wasStatus != "needsInput"
        if (!settled && !asks) return false
        val signature = "$status@$updatedAt"
        if (notified[key] == signature) return false
        notified[key] = signature
        if (openAndVisible) return false
        if (settled && !completionsEnabled) return false
        return true
    }

    /** Drops remembered state for one session (host switch hygiene). */
    @Synchronized
    fun forget(key: String) {
        notified.remove(key)
    }

    @Synchronized
    fun clear() {
        notified.clear()
    }
}
