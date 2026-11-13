package dev.pi.remote.sync

import dev.pi.remote.protocol.ActivityCounts
import dev.pi.remote.protocol.OpenResult
import dev.pi.remote.protocol.RemoteJson
import dev.pi.remote.protocol.SessionState
import dev.pi.remote.protocol.TextAppend
import dev.pi.remote.protocol.Turn
import dev.pi.remote.protocol.TurnActivity
import dev.pi.remote.protocol.TurnPatchEvent
import dev.pi.remote.protocol.TurnSettle
import dev.pi.remote.protocol.TurnUpsert
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlinx.serialization.json.jsonObject

class SessionTimelineSyncTest {
    private val key = "C:/Users/quoc/.pi/sessions/a.jsonl"
    private val fixtureDir = File(System.getProperty("pi.remote.fixtures") ?: "../../../packages/shared/remote/fixtures", "messages")
    private fun fixture(name: String) = RemoteJson.parseToJsonElement(File(fixtureDir, "$name.json").readText()).jsonObject["value"]!!
    private val baseOpen = RemoteJson.decodeFromJsonElement(OpenResult.serializer(), fixture("method.session.open.result"))

    private fun emptySnapshot(seq: Long = 1, epoch: String = "e1") = baseOpen.copy(
        sessionKey = key,
        epoch = epoch,
        seq = seq,
        kind = "snapshot",
        turns = emptyList(),
        patches = null,
        state = SessionState(running = false),
    )

    private fun liveTurn(text: String = "chào"): Turn {
        val previous = baseOpen.turns!!.last()
        return previous.copy(
            id = "live:test",
            anchor = "live:test",
            status = "running",
            user = previous.user.copy(text = text),
            activity = TurnActivity(ActivityCounts.Empty, failed = 0),
            steps = emptyList(),
            answer = "",
            files = emptyList(),
        )
    }

    @Test
    fun buffersWindowsKeyPatchesThatArriveBeforeInitialOpenResponse() {
        val sync = SessionTimelineSync(key)
        val openId = sync.beginOpen("e1")
        val turn = liveTurn()
        val event = TurnPatchEvent(
            sessionKey = "C:\\Users\\quoc\\.pi\\sessions\\a.jsonl",
            patches = listOf(
                TurnUpsert(op = "turn.upsert", seq = 2, turn = turn),
                TextAppend(op = "text.append", seq = 3, turnId = turn.id, ref = "answer", delta = "xin chào"),
                TurnSettle(op = "turn.settle", seq = 4, turnId = turn.id, status = "done", files = emptyList()),
            ),
        )

        assertIs<SessionSyncResult.Buffered>(sync.onPatch(event, "e1"))
        val result = sync.completeOpen(openId, emptySnapshot(seq = 1))

        val timeline = assertIs<SessionSyncResult.Applied>(result).timeline
        assertEquals(4L, timeline.seq)
        assertEquals("chào", timeline.turns.last().user.text)
        assertEquals("xin chào", timeline.turns.last().answer)
        assertEquals("done", timeline.turns.last().status)
    }

    @Test
    fun snapshotAlreadyContainingBufferedPatchDoesNotApplyItTwice() {
        val sync = SessionTimelineSync(key)
        val openId = sync.beginOpen("e1")
        val turn = liveTurn()
        val event = TurnPatchEvent(key, listOf(TextAppend("text.append", 3, null, turn.id, "answer", "hello")))
        assertIs<SessionSyncResult.Buffered>(sync.onPatch(event, "e1"))

        val snapshot = emptySnapshot(seq = 3).copy(turns = listOf(turn.copy(answer = "hello")))
        val timeline = assertIs<SessionSyncResult.Applied>(sync.completeOpen(openId, snapshot)).timeline
        assertEquals("hello", timeline.turns.last().answer)
        assertEquals(3L, timeline.seq)
    }

    @Test
    fun anOlderOpenResponseCannotReplaceAnewerOpenGeneration() {
        val sync = SessionTimelineSync(key)
        val stale = sync.beginOpen("e1")
        val current = sync.beginOpen("e1")

        assertIs<SessionSyncResult.StaleOpen>(sync.completeOpen(stale, emptySnapshot(seq = 1)))
        val installed = sync.completeOpen(current, emptySnapshot(seq = 2))
        assertEquals(2L, assertIs<SessionSyncResult.Applied>(installed).timeline.seq)
    }

    @Test
    fun replayGapKeepsTheLastContiguousCursorAndRequestsSnapshot() {
        val sync = SessionTimelineSync(key)
        val initial = baseOpen.copy(sessionKey = key, epoch = "e1", seq = 4, kind = "snapshot")
        val first = sync.beginOpen("e1")
        assertIs<SessionSyncResult.Applied>(sync.completeOpen(first, initial))

        val gapResponse = emptySnapshot(seq = 8, epoch = "e1").copy(
            kind = "replay",
            turns = null,
            patches = listOf(TurnUpsert("turn.upsert", seq = 6, turn = liveTurn())),
        )
        val second = sync.beginOpen("e1")
        val result = sync.completeOpen(second, gapResponse)

        val needsResync = assertIs<SessionSyncResult.NeedsResync>(result)
        assertEquals("gap inside session.open replay", needsResync.reason)
        assertEquals(4L, needsResync.timeline?.seq)
    }

    @Test
    fun aNewEpochReplacesTheOldTimelineAndDrainsNewEpochPatches() {
        val sync = SessionTimelineSync(key)
        val first = sync.beginOpen("e1")
        val oldTimeline = baseOpen.copy(sessionKey = key, epoch = "e1", kind = "snapshot")
        assertIs<SessionSyncResult.Applied>(sync.completeOpen(first, oldTimeline))

        val next = sync.beginOpen("e2", fresh = true)
        val turn = liveTurn("new epoch")
        assertIs<SessionSyncResult.Buffered>(
            sync.onPatch(TurnPatchEvent(key, listOf(TurnUpsert("turn.upsert", 1, turn))), "e2"),
        )
        val snapshot = emptySnapshot(seq = 0, epoch = "e2")
        val result = assertIs<SessionSyncResult.Applied>(sync.completeOpen(next, snapshot)).timeline
        assertEquals("e2", result.epoch)
        assertEquals(listOf("new epoch"), result.turns.map { it.user.text })
    }

    @Test
    fun liveSequenceGapRequestsResyncWithoutAdvancingPastTheHole() {
        val sync = SessionTimelineSync(key)
        val initial = sync.beginOpen("e1")
        assertIs<SessionSyncResult.Applied>(sync.completeOpen(initial, emptySnapshot(seq = 1)))

        val gap = assertIs<SessionSyncResult.NeedsResync>(
            sync.onPatch(TurnPatchEvent(key, listOf(TurnUpsert("turn.upsert", 3, liveTurn()))), "e1"),
        )
        assertEquals(1L, gap.timeline?.seq)
        assertEquals("live patch sequence gap", gap.reason)
    }

    @Test
    fun eventForAnotherSessionIsIgnoredAndDoesNotCreateTimeline() {
        val sync = SessionTimelineSync(key)
        val result = sync.onPatch(TurnPatchEvent("C:/other/session.jsonl", emptyList()), "e1")
        assertIs<SessionSyncResult.Ignored>(result)
        assertNull(sync.current())
    }

    @Test
    fun bufferOverflowRequestsResyncInsteadOfSilentlyDroppingPatches() {
        val sync = SessionTimelineSync(key, maxBufferedPatches = 1)
        val openId = sync.beginOpen("e1")
        val turn = liveTurn()
        val event = TurnPatchEvent(
            key,
            listOf(
                TurnUpsert("turn.upsert", 2, turn),
                TextAppend("text.append", 3, null, turn.id, "answer", "x"),
            ),
        )
        val result = assertIs<SessionSyncResult.NeedsResync>(sync.onPatch(event, "e1"))
        assertEquals("live patch buffer overflow", result.reason)

        assertIs<SessionSyncResult.NeedsResync>(sync.completeOpen(openId, emptySnapshot(seq = 1)))
    }
}
