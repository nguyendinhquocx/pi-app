package dev.pi.remote.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ExternalRefreshGateTest {
    private var at = 0L
    private fun gate(): ExternalRefreshGate = ExternalRefreshGate(minIntervalMs = 30_000L) { at }

    private fun fingerprint(status: String = "idle", preview: String = "answer") =
        ExternalRefreshGate.summaryFingerprint(status, preview)

    /** Seed the baseline for `key` so later calls observe a fingerprint change, not first sight. */
    private fun seed(gate: ExternalRefreshGate, key: String = "s", stamp: Long = 100) {
        gate.shouldReopen(key, fingerprint(), stamp, knownUpdatedAt = null, lastPatchAt = null, lastResetAt = null, running = false)
    }

    private fun ask(
        gate: ExternalRefreshGate,
        key: String = "s",
        status: String = "idle",
        preview: String = "answer",
        stamp: Long = 100,
        known: Long? = stamp,
        lastPatchAt: Long? = null,
        lastResetAt: Long? = null,
        running: Boolean = false,
    ) = gate.shouldReopen(
        key,
        fingerprint(status, preview),
        stamp,
        knownUpdatedAt = known,
        lastPatchAt = lastPatchAt,
        lastResetAt = lastResetAt,
        running = running,
    )

    @Test
    fun firstObservationOnlySeedsTheBaseline() {
        val gate = gate()
        assertFalse(ask(gate, stamp = 100, known = null))
        // Same fingerprint afterwards: nothing new.
        assertFalse(ask(gate, stamp = 101, known = 100))
    }

    @Test
    fun staleUpdateNeverReopens() {
        val gate = gate()
        seed(gate, stamp = 100)
        assertFalse(ask(gate, stamp = 100, known = 100, preview = "changed"))
        assertFalse(ask(gate, stamp = 99, known = 100, preview = "changed"))
    }

    @Test
    fun changedFingerprintWithNoPatchesReopensOncePerChange() {
        val gate = gate()
        seed(gate, stamp = 100)

        at = 1_000
        assertTrue(ask(gate, stamp = 200, known = 100, preview = "turn 2"))
        // Debounced within the min interval, and stays quiet once the change is reflected.
        assertFalse(ask(gate, stamp = 201, known = 200, preview = "turn 2"))
        at = 31_000
        assertFalse(ask(gate, stamp = 202, known = 201, preview = "turn 2"))
        // A further content change fires again.
        assertTrue(ask(gate, stamp = 203, known = 202, preview = "turn 3"))
    }

    @Test
    fun livePatchesSuppressReopenAndAbsorbTheSummary() {
        val gate = gate()
        seed(gate, stamp = 100)
        at = 5_000
        assertFalse(ask(gate, stamp = 101, known = 100, preview = "turn 2", lastPatchAt = 3_000))
        // The patch-time window passed, but the change was absorbed while live: quiet.
        at = 40_000
        assertFalse(ask(gate, stamp = 102, known = 101, preview = "turn 2"))
        assertTrue(ask(gate, stamp = 103, known = 102, preview = "turn 3"))
    }

    @Test
    fun recentResetLeavesResyncInCharge() {
        val gate = gate()
        seed(gate, stamp = 100)
        at = 5_000
        assertFalse(ask(gate, stamp = 101, known = 100, preview = "rewound", lastResetAt = 4_000))
        at = 40_000
        assertFalse(ask(gate, stamp = 102, known = 101, preview = "rewound"))
        assertTrue(ask(gate, stamp = 103, known = 102, preview = "after rewind"))
    }

    @Test
    fun runningSessionSkipsUntilItSettles() {
        val gate = gate()
        seed(gate, stamp = 100)
        at = 5_000
        // Streaming: skip (and absorb) no matter what the summary says.
        assertFalse(ask(gate, status = "running", preview = "step…", stamp = 101, known = 100, running = true))
        at = 40_000
        // Settled without any patch having arrived: the gap is real, catch up once.
        assertTrue(ask(gate, preview = "settled", stamp = 102, known = 101))
        assertFalse(ask(gate, preview = "settled", stamp = 103, known = 102))
    }

    @Test
    fun forgetDropsTheBaselineSoTheNextObservationSeedsAgain() {
        val gate = gate()
        seed(gate, stamp = 100)
        at = 1_000
        assertTrue(ask(gate, stamp = 200, known = 100, preview = "turn 2"))
        gate.forget("s")
        assertFalse(ask(gate, stamp = 201, known = 200, preview = "turn 2"))
    }

    @Test
    fun clearDropsEverySession() {
        val gate = gate()
        seed(gate)
        seed(gate, key = "t")
        gate.clear()
        at = 1_000
        assertFalse(ask(gate, stamp = 101, known = 100))
        assertFalse(ask(gate, key = "t", stamp = 101, known = 100))
    }

    @Test
    fun summaryFingerprintTreatsStatusAndPreviewAsIdentity() {
        assertEquals("idle|answer", fingerprint())
        assertEquals("|", ExternalRefreshGate.summaryFingerprint(null, null))
        assertTrue(fingerprint("running", "answer") != fingerprint("idle", "answer"))
        assertTrue(fingerprint("idle", "a") != fingerprint("idle", "b"))
    }
}
