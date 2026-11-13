package dev.pi.remote.app.data

/**
 * Guards the single live session subscription on one gateway connection. A session.open response
 * can arrive after navigation changed; its generation token prevents that stale completion from
 * being treated as the session currently visible.
 */
internal class ActiveSessionGate {
    private var activeKey: String? = null
    private var generation = 0L

    @Synchronized
    fun activate(key: String): Long {
        require(key.isNotBlank()) { "session key must be non-empty" }
        activeKey = key
        generation += 1
        return generation
    }

    @Synchronized
    fun deactivate(key: String): Long {
        if (activeKey == key) {
            activeKey = null
            generation += 1
        }
        return generation
    }

    @Synchronized
    fun clear(): Long {
        activeKey = null
        generation += 1
        return generation
    }

    @Synchronized
    fun snapshot(): Pair<String?, Long> = activeKey to generation

    @Synchronized
    fun isCurrent(key: String, token: Long): Boolean = activeKey == key && generation == token

    @Synchronized
    fun isActive(key: String): Boolean = activeKey == key
}
