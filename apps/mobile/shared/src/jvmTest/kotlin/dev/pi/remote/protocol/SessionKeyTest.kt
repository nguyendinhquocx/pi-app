package dev.pi.remote.protocol

import kotlin.test.Test
import kotlin.test.assertEquals

class SessionKeyTest {

    @Test fun blankAndNullCollapseToEmptyKey() {
        assertEquals("", canonicalSessionKey(null))
        assertEquals("", canonicalSessionKey(""))
        assertEquals("", canonicalSessionKey("   \t "))
    }

    @Test fun windowsBackslashesBecomeForwardSlashes() {
        assertEquals(
            "C:/Users/quoc/.pi/sessions/a.jsonl",
            canonicalSessionKey("C:\\Users\\quoc\\.pi\\sessions\\a.jsonl"),
        )
        assertEquals("C:/a/b/c", canonicalSessionKey("C:\\a//b\\\\c"))
    }

    @Test fun lowerCaseDriveLetterIsUpperCased() {
        assertEquals("D:/data/session.jsonl", canonicalSessionKey("d:/data/session.jsonl"))
        assertEquals("D:/data/session.jsonl", canonicalSessionKey("D:/data/session.jsonl"))
        assertEquals(
            "C:/users/quoc/s.JPG",
            canonicalSessionKey("c:\\users\\quoc\\s.JPG"),
        )
    }

    @Test fun canonicalKeysAreIdempotent() {
        val paths = listOf(
            "C:\\Users\\quoc\\.pi\\s.jsonl",
            "//server/share/s.jsonl",
            "/home/quoc//.pi/s.jsonl",
            "d:/x//y/s.jsonl",
        )
        for (path in paths) {
            val once = canonicalSessionKey(path)
            assertEquals(once, canonicalSessionKey(once), "not idempotent for: $path")
        }
    }

    @Test fun uncPrefixIsPreservedExactlyOnce() {
        // Exactly-two-slash inputs keep the UNC prefix; inputs with >2 leading slashes
        // collapse to three, faithfully mirroring TS `//${key.slice(2).replace(/\/+/, '/')}`.
        assertEquals("//server/share/s.jsonl", canonicalSessionKey("\\\\server\\share\\s.jsonl"))
        assertEquals("//server/share", canonicalSessionKey("//server//share"))
        assertEquals("///server/share/", canonicalSessionKey("////server//share//"))
        assertEquals("//", canonicalSessionKey("//"))
        assertEquals("//", canonicalSessionKey("\\\\"))
    }

    @Test fun posixDuplicateSlashesCollapse() {
        assertEquals("/home/quoc/.pi/s.jsonl", canonicalSessionKey("/home//quoc///.pi/s.jsonl"))
        assertEquals("/var/log/pi/", canonicalSessionKey("/var/log/pi///"))
    }

    @Test fun nonDrivePathCaseIsPreserved() {
        assertEquals("/Home/Quoc/Session.JSONL", canonicalSessionKey("/Home//Quoc/Session.JSONL"))
        assertEquals("//Server/Share/Mixed.Case", canonicalSessionKey("\\\\Server\\Share\\Mixed.Case"))
        assertEquals("weird:name/path", canonicalSessionKey("weird:name/path"))
    }
}
