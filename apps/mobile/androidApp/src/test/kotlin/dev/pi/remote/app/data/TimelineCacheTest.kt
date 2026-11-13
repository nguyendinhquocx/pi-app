package dev.pi.remote.app.data

import dev.pi.remote.protocol.RemoteJson
import dev.pi.remote.protocol.canonicalSessionKey
import dev.pi.remote.sync.SessionTimeline
import java.io.File
import java.security.MessageDigest
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

class TimelineCacheTest {
    private val root = Files.createTempDirectory("pi-remote-timeline-cache").toFile()

    @After
    fun cleanup() {
        root.deleteRecursively()
    }

    @Test
    fun canonicalLookupReadsLegacyRawWindowsPathCacheAndWritesCanonicalKey() {
        val hostId = "host-a"
        val raw = "C:\\Users\\quoc\\.pi\\sessions\\same.jsonl"
        val canonical = "C:/Users/quoc/.pi/sessions/same.jsonl"
        val legacyName = MessageDigest.getInstance("SHA-256")
            .digest(raw.encodeToByteArray())
            .joinToString("") { "%02x".format(it) }
            .take(32)
        val legacyFile = File(root, "$hostId/turns/$legacyName.json")
        legacyFile.parentFile!!.mkdirs()
        val old = CachedTimeline.of(SessionTimeline(raw, title = "old cache"))
        legacyFile.writeText(RemoteJson.encodeToString(CachedTimeline.serializer(), old))

        val cache = TimelineCache(root)
        val loaded = cache.loadTimeline(hostId, canonical)
        assertNotNull(loaded)
        assertEquals(canonical, loaded!!.sessionKey)

        cache.saveTimeline(hostId, loaded)
        val canonicalName = MessageDigest.getInstance("SHA-256")
            .digest(canonical.encodeToByteArray())
            .joinToString("") { "%02x".format(it) }
            .take(32)
        assertEquals(canonical, canonicalSessionKey(loaded.sessionKey))
        assertEquals(true, File(root, "$hostId/turns/$canonicalName.json").exists())
    }
}
