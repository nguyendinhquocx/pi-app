package dev.pi.remote.app.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import dev.pi.remote.R
import dev.pi.remote.protocol.SessionSummary
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [32])
class RunNotifierTest {
    private lateinit var context: Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
    }

    private fun summary(status: String, outcome: String?, preview: String? = null) = SessionSummary(
        sessionKey = "session",
        projectId = "project",
        title = "test",
        status = status,
        updatedAt = 1_000,
        preview = preview,
        settledOutcome = outcome,
        settledAt = outcome?.let { 1_000 },
    )

    @Test
    fun externalFailureOutcomeUsesFailureCopyEvenWhenInboxStatusWasIdle() {
        val s = summary("failed", "failed", "exit code 1")
        assertEquals(context.getString(R.string.notif_failed, "exit code 1"), notificationText(context, s))
    }

    @Test
    fun cancelledOutcomeDoesNotSayFinished() {
        val s = summary("idle", "cancelled")
        assertEquals(context.getString(R.string.notif_cancelled), notificationText(context, s))
    }

    @Test
    fun needsInputWinsOverAnyStaleCompletionMetadata() {
        val s = summary("needsInput", "success", "Choose an option")
        assertEquals(context.getString(R.string.notif_needs, "Choose an option"), notificationText(context, s))
    }
}
