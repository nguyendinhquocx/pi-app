package dev.pi.remote.protocol

/**
 * Canonical session file path keys for Map lookups / equality, mirroring
 * `packages/shared/session-file-key.ts` `normalizeSessionFileKey`.
 *
 * The desktop main process resolves paths (drive-letter casing, consistent
 * separators) while mobile clients may see mixed separators or casing from
 * JSONL session lists vs worker events; strict string equality breaks
 * session routing unless both sides compare canonical keys.
 */
public object SessionKey {

    private val DUPLICATE_SLASH = Regex("/+")

    /**
     * Normalizes [raw] for use as a canonical session-file key:
     * 1. null/blank -> ""; surrounding whitespace is trimmed.
     * 2. Backslashes become forward slashes.
     * 3. Repeated slashes collapse to one, except a leading `//` (UNC prefix),
     *    which is preserved exactly once; repeats after it still collapse.
     * 4. A Windows drive letter (`[A-Za-z]:/` at start) is upper-cased.
     * 5. All other path-component case is preserved; POSIX paths stay POSIX.
     */
    public fun canonical(raw: String?): String {
        val trimmed = raw?.trim().orEmpty()
        if (trimmed.isEmpty()) return ""
        val slashed = trimmed.replace('\\', '/')
        val collapsed = if (slashed.startsWith("//")) {
            "//" + slashed.substring(2).replace(DUPLICATE_SLASH, "/")
        } else {
            slashed.replace(DUPLICATE_SLASH, "/")
        }
        if (isWindowsDrivePath(collapsed)) {
            return collapsed[0].uppercaseChar() + collapsed.substring(1)
        }
        return collapsed
    }

    private fun isWindowsDrivePath(key: String): Boolean =
        key.length >= 3 &&
            (key[0] in 'a'..'z' || key[0] in 'A'..'Z') &&
            key[1] == ':' &&
            key[2] == '/'
}

/** Top-level alias matching the working-spec contract name. */
public fun canonicalSessionKey(raw: String?): String = SessionKey.canonical(raw)
