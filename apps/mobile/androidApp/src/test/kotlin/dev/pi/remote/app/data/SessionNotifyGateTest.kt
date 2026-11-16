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
        settledOutcome: String? = "success",
        settledAt: Long? = 1_000,
        wasSettledAt: Long? = null,
        openAndVisible: Boolean = false,
        completionsEnabled: Boolean = true,
    ) = gate.shouldNotify(key, was, status, updatedAt, settledOutcome, settledAt, wasSettledAt, openAndVisible, completionsEnabled)

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
        // Status stuck without an outcome = backstop/stale summary: silent.
        assertFalse(ask(g, was = "idle", status = "idle", settledOutcome = null))
        assertFalse(ask(g, was = "failed", status = "failed", settledOutcome = null))
        // Still running is never a completion, outcome or not.
        assertFalse(ask(g, was = "running", status = "running", settledOutcome = "success"))
    }

    @Test
    fun runningToTerminalNotifies() {
        val g = gate()
        assertTrue(ask(g, was = "running", status = "idle", updatedAt = 1_000))
        // A different session, same shape.
        assertTrue(ask(g, key = "t", was = "running", status = "failed", updatedAt = 2_000, settledOutcome = "failed"))
    }

    @Test
    fun backstopFlipWithoutOutcomeNeverNotifies() {
        val g = gate()
        // 90s file-silence backstop: status flips to idle while a long tool call still runs —
        // the summary carries no settledOutcome, so this is not a completion.
        assertFalse(ask(g, settledOutcome = null))
        assertFalse(ask(g, was = "running", status = "failed", settledOutcome = null))
        // The real completion afterwards (fresh tail, new stamp) still notifies.
        assertTrue(ask(g, updatedAt = 9_000))
    }

    @Test
    fun completionAfterBackstopFlipStillNotifies() {
        val g = gate()
        // Long tool call: the 90s backstop flips status to idle without an outcome. The phone's
        // baseline status is now idle — the real completion lands as idle→idle with an outcome.
        assertFalse(ask(g, was = "running", status = "idle", updatedAt = 1_000, settledOutcome = null))
        assertTrue(ask(g, was = "idle", status = "idle", updatedAt = 61_000, settledAt = 61_000))
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
        // A stale completion outcome must not make a needsInput question subject to this toggle.
        assertTrue(ask(g, was = "idle", status = "needsInput", updatedAt = 1_000, settledOutcome = "success", completionsEnabled = false))
    }

    @Test
    fun questionTransitionsNotify() {
        val g = gate()
        assertTrue(ask(g, was = "idle", status = "needsInput", updatedAt = 1_000, settledOutcome = "success"))
        // Same question replayed: deduped.
        assertFalse(ask(g, was = "needsInput", status = "needsInput", updatedAt = 1_000, settledOutcome = "success"))
    }

    @Test
    fun longCompletionCanCatchUpEvenWhenRunDurationExceedsTwoMinutes() {
        val g = gate()
        // The host's outcome timestamp is fresh even though updatedAt delta includes a >2m run.
        assertTrue(ask(g, was = "running", status = "idle", updatedAt = 131_000, settledAt = 131_000))
    }

    @Test
    fun sameSummaryReplayIsDeduped() {
        val g = gate()
        assertTrue(ask(g, was = "running", status = "idle", updatedAt = 1_000, settledAt = 1_000))
        // A replay after reconnect has the same settle identity even if unrelated row metadata changes.
        assertFalse(ask(g, was = "idle", status = "idle", updatedAt = 9_000, settledAt = 1_000, wasSettledAt = 1_000))
    }

    @Test
    fun newCompletionAfterANotifiedOneNotifiesAgain() {
        val g = gate()
        assertTrue(ask(g, was = "running", status = "idle", updatedAt = 1_000, settledAt = 1_000))
        // Second run completes later: a new settle timestamp fires again, even if Android missed running.
        assertTrue(ask(g, was = "idle", status = "idle", updatedAt = 9_000, settledAt = 9_000, wasSettledAt = 1_000))
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
