package dev.pi.remote.app.data

import org.junit.Assert.assertEquals
import org.junit.Test

class BackstopKeepAliveGateTest {
    @Test
    fun backstopIdleKeepsMonitoringForBoundedGrace() {
        val gate = BackstopKeepAliveGate(graceMs = 120_000)
        gate.observe("s", wasStatus = "running", status = "idle", settledOutcome = null, now = 10_000)
        assertEquals(1, gate.activeCount(now = 129_999))
        assertEquals(0, gate.activeCount(now = 130_000))
    }

    @Test
    fun realOutcomeEndsGraceImmediately() {
        val gate = BackstopKeepAliveGate(graceMs = 120_000)
        gate.observe("s", "running", "idle", null, now = 10_000)
        gate.observe("s", "idle", "idle", "success", now = 20_000)
        assertEquals(0, gate.activeCount(now = 20_000))
    }

    @Test
    fun newRunOrQuestionEndsGrace() {
        val gate = BackstopKeepAliveGate(graceMs = 120_000)
        gate.observe("s", "running", "idle", null, now = 10_000)
        gate.observe("s", "idle", "running", null, now = 20_000)
        assertEquals(0, gate.activeCount(now = 20_000))
        gate.observe("s", "running", "idle", null, now = 30_000)
        gate.observe("s", "idle", "needsInput", null, now = 40_000)
        assertEquals(0, gate.activeCount(now = 40_000))
    }

    @Test
    fun repeatedIdleDoesNotExtendGraceAndHostSwitchCanClearIt() {
        val gate = BackstopKeepAliveGate(graceMs = 120_000)
        gate.observe("s", "running", "idle", null, now = 10_000)
        gate.observe("s", "idle", "idle", null, now = 100_000)
        assertEquals(1, gate.activeCount(now = 129_999))
        assertEquals(0, gate.activeCount(now = 130_000))
        gate.observe("t", "running", "idle", null, now = 200_000)
        gate.forget("t")
        assertEquals(0, gate.activeCount(now = 200_000))
    }
}
