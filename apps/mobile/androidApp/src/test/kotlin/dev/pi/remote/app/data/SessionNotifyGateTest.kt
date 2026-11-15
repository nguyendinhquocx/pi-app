package dev.pi.remote.app.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Notification decisions for `sessions.update` transitions (see [SessionNotifyGate]). */
class SessionNotifyGateTest {
    private fun gate() = SessionNotifyGate()

    private fun ask(
        gate: SessionNotifyGate,
        key: String = "s",
        was: String? = "running",
        status: String = "idle",
        updatedAt: Long = 1_000,
        openAndVisible: Boolean = false,
        completionsEnabled: Boolean = true,
    ) = gate.shouldNotify(key, was, status, updatedAt, openAndVisible, completionsEnabled)

    @Test
    fun firstSightingOnlySeedsTheBaseline() {
        val g = gate()
        assertFalse(ask(g, was = null))
        // Later transitions from that seeded baseline still work.
        assertTrue(ask(g, was = "running"))
    }

    @Test
    fun noTransitionNeverNotifies() {
        val g = gate()
        assertFalse(ask(g, was = "idle", status = "idle"))
        assertFalse(ask(g, was = "running", status = "running"))
        assertFalse(ask(g, was = "failed", status = "failed"))
    }

    @Test
    fun runningToTerminalNotifies() {
        val g = gate()
        assertTrue(ask(g, was = "running", status = "idle", updatedAt = 1_000))
        // A different session, same shape.
        assertTrue(ask(g, key = "t", was = "running", status = "failed", updatedAt = 2_000))
    }

    @Test
    fun openOnScreenSessionNeverNotifies() {
        val g = gate()
        assertFalse(ask(g, openAndVisible = true))
        // Closed afterwards: nothing re-fires (the transition was consumed by the live view).
        assertFalse(ask(g, openAndVisible = false))
    }

    @Test
    fun toggleOffSilencesCompletionsButNotQuestions() {
        val g = gate()
        assertFalse(ask(g, completionsEnabled = false))
        assertTrue(ask(g, was = "idle", status = "needsInput", updatedAt = 1_000, completionsEnabled = false))
    }

    @Test
    fun questionTransitionsNotify() {
        val g = gate()
        assertTrue(ask(g, was = "idle", status = "needsInput", updatedAt = 1_000))
        // Same question replayed: deduped.
        assertFalse(ask(g, was = "needsInput", status = "needsInput", updatedAt = 1_000))
    }

    @Test
    fun sameSummaryReplayIsDeduped() {
        val g = gate()
        assertTrue(ask(g, updatedAt = 1_000))
        assertFalse(ask(g, updatedAt = 1_000))
    }

    @Test
    fun newCompletionAfterANotifiedOneNotifiesAgain() {
        val g = gate()
        assertTrue(ask(g, was = "running", status = "idle", updatedAt = 1_000))
        // Second run completes later: new stamp, fires again.
        assertTrue(ask(g, was = "running", status = "idle", updatedAt = 9_000))
    }

    @Test
    fun clearAndForgetDropDedupeState() {
        val g = gate()
        assertTrue(ask(g, updatedAt = 1_000))
        g.forget("s")
        assertTrue(ask(g, updatedAt = 1_000))
        g.clear()
        assertTrue(ask(g, updatedAt = 1_000))
    }
}
