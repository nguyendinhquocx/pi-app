package dev.pi.remote.app.data

import android.app.LocaleManager
import android.content.Context
import android.content.res.Configuration
import android.os.Build
import android.os.LocaleList
import java.util.Locale

/**
 * App language: `system` | `en` | `zh` | `vi`. Android 13+ keeps it as the per-app locale (also editable
 * in the system's App languages page); older versions wrap each Context with the chosen locale.
 *
 * Fresh install vs saved System: an empty preference means "never chose", and the fork's
 * fresh-install default is Vietnamese — applied exactly once by [ensureInitialized] before the
 * first UI composes. Choosing System inside the app persists the explicit marker, so the
 * initializer never overwrites it on a later start.
 */
object AppLocale {
    const val PREFS = "ui"
    const val KEY = "language"
    private const val INIT_KEY = "languageInitialized"

    fun tag(language: String): String? = when (language) {
        "en" -> "en"
        "zh" -> "zh-CN"
        "vi" -> "vi"
        else -> null
    }

    fun fromTag(tag: String?): String = when {
        tag.isNullOrEmpty() -> "system"
        tag.startsWith("zh") -> "zh"
        tag.startsWith("vi") -> "vi"
        tag.startsWith("en") -> "en"
        else -> "system"
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun isInitialized(context: Context): Boolean = prefs(context).getBoolean(INIT_KEY, false)

    /**
     * One-time fresh-install default: writes `vi` (per-app locale on 13+, preference below) the
     * first time the app ever runs. A system-chosen app locale (13+) wins if it exists already,
     * and an explicitly saved choice keeps [INIT_KEY] set so this never runs again.
     */
    fun ensureInitialized(context: Context) {
        if (isInitialized(context)) return
        prefs(context).edit().putBoolean(INIT_KEY, true).apply()
        if (Build.VERSION.SDK_INT >= 33) {
            val manager = context.getSystemService(LocaleManager::class.java)
            if (manager.applicationLocales.isEmpty) {
                manager.applicationLocales = LocaleList.forLanguageTags("vi")
            }
        } else {
            prefs(context).edit().putString(KEY, "vi").apply()
        }
    }

    /** The current choice: the system's per-app locale on 13+, the saved preference before that. */
    fun read(context: Context): String =
        if (Build.VERSION.SDK_INT >= 33) {
            val locales = context.getSystemService(LocaleManager::class.java).applicationLocales
            fromTag(if (locales.isEmpty) null else locales[0].toLanguageTag())
        } else {
            val default = if (isInitialized(context)) "system" else "vi"
            prefs(context).getString(KEY, default) ?: default
        }

    /** Apply a choice: 13+ recreates the activities itself; older versions need [wrap] + recreate. */
    fun apply(context: Context, language: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, language).apply()
        if (Build.VERSION.SDK_INT >= 33) {
            val tag = tag(language)
            context.getSystemService(LocaleManager::class.java).applicationLocales =
                if (tag == null) LocaleList.getEmptyLocaleList() else LocaleList.forLanguageTags(tag)
        }
    }

    /** Android 12 and older: a Context whose resources (and the default Locale) use the chosen language. */
    fun wrap(base: Context): Context {
        if (Build.VERSION.SDK_INT >= 33) return base
        val tag = tag(read(base)) ?: return base
        val locale = Locale.forLanguageTag(tag)
        Locale.setDefault(locale)
        val config = Configuration(base.resources.configuration)
        config.setLocales(LocaleList(locale))
        return base.createConfigurationContext(config)
    }
}
