package dev.pi.remote.app.data

import android.app.LocaleManager
import android.content.Context
import android.os.Build
import android.os.LocaleList
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.Locale

/**
 * Locale persistence: fresh-install default vi (exactly once), explicit System/en/zh/vi choices
 * survive restarts, and tag round-trips accept vi / vi-*.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [32, 33])
class AppLocaleTest {
    private lateinit var context: Context

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.getSharedPreferences(AppLocale.PREFS, Context.MODE_PRIVATE).edit().clear().commit()
        if (Build.VERSION.SDK_INT >= 33) {
            context.getSystemService(LocaleManager::class.java).applicationLocales =
                LocaleList.getEmptyLocaleList()
        }
    }

    private fun simulateRestart() {
        // Nothing to reset: AppLocale is stateless besides persisted prefs / system app locale.
        // The call below mirrors what PiRemoteApp.attachBaseContext does on every process start.
        AppLocale.ensureInitialized(context)
    }

    @Test
    fun freshInstallDefaultsToVietnameseExactlyOnce() {
        AppLocale.ensureInitialized(context)
        assertEquals("vi", AppLocale.read(context))

        if (Build.VERSION.SDK_INT >= 33) {
            val locales = context.getSystemService(LocaleManager::class.java).applicationLocales
            assertEquals(listOf("vi"), (0 until locales.size()).map { locales[it].toLanguageTag() })
        }

        // Restart: initializer must not re-run or change the choice.
        simulateRestart()
        assertEquals("vi", AppLocale.read(context))
    }

    @Test
    fun savedSystemChoiceSurvivesRestartAndIsNotOverridden() {
        AppLocale.ensureInitialized(context)
        AppLocale.apply(context, "system")

        simulateRestart()
        assertEquals("system", AppLocale.read(context))

        if (Build.VERSION.SDK_INT >= 33) {
            assertTrue(
                context.getSystemService(LocaleManager::class.java).applicationLocales.isEmpty,
            )
        } else {
            // Android 12 and below: an empty per-app concept means wrap() uses the system locale.
            assertEquals(context.resources.configuration.locales[0], Locale.getDefault())
        }
    }

    @Test
    fun savedExplicitChoicesSurviveRestart() {
        for (choice in listOf("en", "zh", "vi")) {
            context.getSharedPreferences(AppLocale.PREFS, Context.MODE_PRIVATE).edit().clear().commit()
            AppLocale.ensureInitialized(context)
            AppLocale.apply(context, choice)

            simulateRestart()
            assertEquals("saved $choice", choice, AppLocale.read(context))
        }
    }

    @Test
    fun tagRoundTripsVietnameseVariants() {
        assertEquals("vi", AppLocale.tag("vi"))
        assertEquals("vi", AppLocale.fromTag("vi"))
        assertEquals("vi", AppLocale.fromTag("vi-VN"))
        assertEquals("vi", AppLocale.fromTag("vi-Latn-VN"))
        assertEquals("zh", AppLocale.fromTag("zh-CN"))
        assertEquals("system", AppLocale.fromTag(null))
        assertEquals("system", AppLocale.fromTag(""))
    }

    @Test
    fun wrapOnOlderAndroidUsesChosenLocaleWhileSystemKeepsDefault() {
        if (Build.VERSION.SDK_INT >= 33) return
        AppLocale.ensureInitialized(context)
        AppLocale.apply(context, "vi")
        Locale.setDefault(Locale.forLanguageTag("en-US"))

        val wrapped = AppLocale.wrap(context)
        assertEquals("vi", wrapped.resources.configuration.locales[0].language)

        AppLocale.apply(context, "system")
        assertEquals(context.resources.configuration.locales[0], AppLocale.wrap(context).resources.configuration.locales[0])
    }
}
