package dev.pi.remote.app

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element

/** English (default), Chinese and Vietnamese resources carry the same keys and the same format arguments. */
class StringsParityTest {
    private val res = listOf(File("src/main/res"), File("androidApp/src/main/res")).first { it.isDirectory }
    /** Brand names: not translated. */
    private val untranslated = setOf("app_name")

    /** Parsed strings.xml: plain strings plus plurals as quantity -> item text. */
    private class Resources(private val untranslated: Set<String>) {
        val strings = mutableMapOf<String, String>()
        val plurals = mutableMapOf<String, Map<String, String>>()
        val keys: Set<String> get() = (strings.keys + plurals.keys) - untranslated
    }

    private fun resources(dir: String): Resources {
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(File(res, "$dir/strings.xml"))
        val nodes = doc.documentElement.childNodes
        val out = Resources(untranslated)
        for (i in 0 until nodes.length) {
            val el = nodes.item(i) as? Element ?: continue
            when (el.tagName) {
                "string" -> out.strings[el.getAttribute("name")] = el.textContent
                "plurals" -> {
                    val items = mutableMapOf<String, String>()
                    for (j in 0 until el.childNodes.length) {
                        val item = el.childNodes.item(j) as? Element ?: continue
                        if (item.tagName == "item") items[item.getAttribute("quantity")] = item.textContent
                    }
                    out.plurals[el.getAttribute("name")] = items
                }
            }
        }
        return out
    }

    /** Multiset of format arguments: a repeated placeholder must occur the same number of times. */
    private fun args(s: String): Map<String, Int> =
        Regex("%(\\d+\\$)?[sdf]").findAll(s).map { it.value }.groupingBy { it }.eachCount()

    @Test
    fun sameKeysAndArguments() {
        val en = resources("values")
        for (dir in listOf("values-zh", "values-vi")) {
            val other = resources(dir)
            assertEquals("keys only in values/ vs $dir/", emptySet<String>(), en.keys - other.keys)
            assertEquals("keys only in $dir/ vs values/", emptySet<String>(), other.keys - en.keys)
            for ((k, v) in en.strings) {
                if (k in untranslated) continue
                assertEquals("format arguments of $k", args(v), args(other.strings.getValue(k)))
            }
            for ((k, items) in en.plurals) {
                if (k in untranslated) continue
                val translated = other.plurals.getValue(k)
                assertTrue("unknown quantities in $k ($dir)", (translated.keys - items.keys).isEmpty())
                for ((quantity, text) in items) {
                    // Locales may omit CLDR-unused quantities (zh drops "one"); compare the ones present in both.
                    val otherText = translated[quantity] ?: continue
                    assertEquals("format arguments of $k[$quantity] ($dir)", args(text), args(otherText))
                }
            }
        }
    }
}
