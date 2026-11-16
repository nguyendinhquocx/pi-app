package dev.pi.remote.app.data

/**
 * Decides which `sessions.update` transitions post a notification. Pure and injectable like
 * [ExternalRefreshGate]: no Android types, and time comes from [now] so tests drive the clock.
 *
 * Rules (mirrors the desktop's external-completion watcher):
 * - A completion requires a fresh [settledOutcome] and a new host [settledAt] identity. The 90s
 *   file-silence backstop can flip status to idle mid-tool; the real completion then arrives
 *   idle→idle with a new outcome timestamp.
 * - `needsInput` is never treated as completion, even if a stale outcome accompanies it; questions
 *   notify independently of the completion toggle. First sighting only seeds the baseline.
 * - The open, on-screen session is the user's live view; the in-app timeline already covers it,
 *   so it never notifies ([openAndVisible]).
 * - Completions honor the Settings toggle ([completionsEnabled]); questions always pass through.
 * - Dedupe by `status@updatedAt` per session: every observed transition is consumed once — the
 *   same summary row replayed (reconnect refresh, hub re-push) never fires twice.
 */
internal class SessionNotifyGate {
    private val notified = HashMap<String, String>()

    @Synchronized
    fun shouldNotify(
        key: String,
        wasStatus: String?,
        status: String,
        updatedAt: Long,
        settledOutcome: String?,
        settledAt: Long?,
        wasSettledAt: Long?,
        openAndVisible: Boolean,
        completionsEnabled: Boolean,
    ): Boolean {
        val asks = wasStatus != null && status == "needsInput" && wasStatus != "needsInput"
        val isTerminal = status != "running" && status != "needsInput"
        val newOutcome = wasStatus != null && settledOutcome != null && settledAt != null && isTerminal &&
            (wasStatus == "running" || wasSettledAt != settledAt)
        if (!newOutcome && !asks) return false
        val signature = if (asks) "$status@$updatedAt" else "$status@$settledOutcome@$settledAt"
        if (notified[key] == signature) return false
        notified[key] = signature
        if (openAndVisible) return false
        if (newOutcome && !completionsEnabled) return false
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
