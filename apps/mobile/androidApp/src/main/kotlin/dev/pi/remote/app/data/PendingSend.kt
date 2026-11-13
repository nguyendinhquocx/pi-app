package dev.pi.remote.app.data

import dev.pi.remote.sync.SessionTimeline

/** One optimistic prompt bubble, correlated with the stable id used by turn.send retries. */
data class PendingSend(
    val messageId: String,
    val text: String,
    val status: PendingSendStatus,
    /** Turns already visible when this send started; old matching text must not clear this bubble. */
    val baselineAnchors: Set<String>,
    val createdAt: Long,
)

enum class PendingSendStatus { Sending, Accepted, Unknown }

/** Pure FIFO reconciliation: consume one new matching turn per pending prompt. */
object PendingSendReconciler {
    private val whitespace = Regex("\\s+")

    fun reconcile(pending: List<PendingSend>, timeline: SessionTimeline): List<PendingSend> {
        if (pending.isEmpty()) return emptyList()
        val available = timeline.turns.toMutableList()
        val unmatched = mutableListOf<PendingSend>()
        for (send in pending.sortedBy { it.createdAt }) {
            val wanted = normalize(send.text)
            val index = available.indexOfFirst { turn ->
                turn.anchor !in send.baselineAnchors && normalize(turn.user.text) == wanted
            }
            if (index >= 0) available.removeAt(index) else unmatched += send
        }
        return unmatched
    }

    private fun normalize(text: String): String = text.trim().replace(whitespace, " ")
}
