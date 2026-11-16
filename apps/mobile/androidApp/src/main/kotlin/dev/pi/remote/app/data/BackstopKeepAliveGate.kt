package dev.pi.remote.app.data

/**
 * Keeps the remote socket alive briefly after an unproven `running -> idle` transition.
 * The host's file-silence backstop can mark a long command idle before its terminal result is
 * written. Keep watching for a bounded grace period so Android can still receive that result
 * and notify while backgrounded; a real outcome, question, or new run ends the grace early.
 */
internal class BackstopKeepAliveGate(private val graceMs: Long = 120_000L) {
    private val deadlines = HashMap<String, Long>()

    @Synchronized
    fun observe(key: String, wasStatus: String?, status: String, settledOutcome: String?, now: Long) {
        when {
            status == "running" || status == "needsInput" || settledOutcome != null -> deadlines.remove(key)
            wasStatus == "running" && status == "idle" -> deadlines.putIfAbsent(key, now + graceMs)
        }
    }

    @Synchronized
    fun activeCount(now: Long): Int {
        deadlines.entries.removeAll { it.value <= now }
        return deadlines.size
    }

    @Synchronized
    fun nextExpiry(now: Long): Long? {
        activeCount(now)
        return deadlines.values.minOrNull()
    }

    @Synchronized
    fun forget(key: String) {
        deadlines.remove(key)
    }

    @Synchronized
    fun clear() {
        deadlines.clear()
    }
}
