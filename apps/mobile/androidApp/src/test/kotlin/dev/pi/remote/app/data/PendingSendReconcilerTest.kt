package dev.pi.remote.app.data

import dev.pi.remote.app.data.PendingSendReconciler.reconcile
import dev.pi.remote.protocol.RemoteJson
import dev.pi.remote.protocol.TurnUser
import dev.pi.remote.sync.SessionTimeline
import dev.pi.remote.sync.TurnStore
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test
import kotlinx.serialization.json.jsonObject

class PendingSendReconcilerTest {
    private val fixtureDir = File(System.getProperty("pi.remote.fixtures") ?: "../../../packages/shared/remote/fixtures", "messages")
    private val open = RemoteJson.decodeFromJsonElement(
        dev.pi.remote.protocol.OpenResult.serializer(),
        RemoteJson.parseToJsonElement(File(fixtureDir, "method.session.open.result.json").readText()).jsonObject["value"]!!,
    )
    private val base: SessionTimeline = TurnStore.fromOpen(null, open)

    private fun turn(anchor: String, text: String) = base.turns.first().copy(
        id = anchor,
        anchor = anchor,
        user = TurnUser(text),
    )

    @Test
    fun onlyAnEchoCreatedAfterSendClearsThePendingBubble() {
        val old = turn("old-anchor", "chào")
        val echoed = turn("new-anchor", "chào")
        val pending = PendingSend(
            messageId = "m_1",
            text = "chào",
            status = PendingSendStatus.Accepted,
            baselineAnchors = setOf("old-anchor"),
            createdAt = 1,
        )

        val remaining = reconcile(listOf(pending), base.copy(turns = listOf(old, echoed)))
        assertEquals(emptyList<PendingSend>(), remaining)
    }

    @Test
    fun repeatedIdenticalPromptsConsumeOneNewTurnEachInSendOrder() {
        val old = turn("old-anchor", "same")
        val first = turn("new-1", "same")
        val second = turn("new-2", "same")
        val pending = listOf(
            PendingSend("m_1", "same", PendingSendStatus.Accepted, setOf("old-anchor"), 1),
            PendingSend("m_2", "same", PendingSendStatus.Sending, setOf("old-anchor"), 2),
        )

        assertEquals(listOf("m_2"), reconcile(pending, base.copy(turns = listOf(old, first))).map { it.messageId })
        assertEquals(emptyList<PendingSend>(), reconcile(pending, base.copy(turns = listOf(old, first, second))))
    }

    @Test
    fun whitespaceDifferencesDoNotLeaveAnAcceptedBubbleBehind() {
        val pending = PendingSend("m_1", "fix\n  bug", PendingSendStatus.Accepted, emptySet(), 1)
        val echoed = turn("new-anchor", "fix bug")
        assertEquals(emptyList<PendingSend>(), reconcile(listOf(pending), base.copy(turns = listOf(echoed))))
    }
}
