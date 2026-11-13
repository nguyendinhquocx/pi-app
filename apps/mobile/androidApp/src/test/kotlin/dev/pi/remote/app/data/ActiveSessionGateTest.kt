package dev.pi.remote.app.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ActiveSessionGateTest {
    @Test
    fun navigationInvalidatesSlowOpenFromThePreviousSession() {
        val gate = ActiveSessionGate()
        val openA = gate.activate("A")

        val openB = gate.activate("B")

        assertFalse(gate.isCurrent("A", openA))
        assertTrue(gate.isCurrent("B", openB))
    }

    @Test
    fun closingOldSessionCannotClearTheNewActiveSession() {
        val gate = ActiveSessionGate()
        val openA = gate.activate("A")
        val openB = gate.activate("B")

        gate.deactivate("A")

        assertFalse(gate.isCurrent("A", openA))
        assertTrue(gate.isCurrent("B", openB))
    }

    @Test
    fun reopeningSameSessionInvalidatesAnOlderOpenGeneration() {
        val gate = ActiveSessionGate()
        val first = gate.activate("A")
        val second = gate.activate("A")

        assertFalse(gate.isCurrent("A", first))
        assertTrue(gate.isCurrent("A", second))
    }
}
