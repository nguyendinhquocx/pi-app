package dev.pi.remote.app.data

import android.app.LocaleManager
import android.content.Context
import android.os.Build
import android.os.LocaleList
import androidx.test.core.app.ApplicationProvider
import java.util.Locale
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Locale persistence: fresh-install default vi (exactly once), explicit System/en/zh/vi choices
 * survive restarts, and tag round-trips accept vi / vi-*.
 *
 * Note: Robolectric's shadow for createConfigurationContext does not surface overridden app
 * locales through `resources.configuration` on SDK < 33, so the wrap() tests assert the JVM
 * default locale (what SimpleDateFormat etc. consume) and the base-vs-wrapped context choice —
 * the behaviors that matter at runtime — instead of the shadowed configuration.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [32, 33])
class AppLocaleTest {
    private lateinit var context: Context
    private val originalDefaultLocale: Locale = Locale.getDefault()

    @Before
    fun setUp() {
        context = ApplicationProvider.getApplicationContext()
        context.getSharedPreferences(AppLocale.PREFS, Context.MODE_PRIVATE).edit().clear().commit()
        if (Build.VERSION.SDK_INT >= 33) {
            context.getSystemService(LocaleManager::class.java).applicationLocales =
                LocaleList.getEmptyLocaleList()
        }
    }

    @After
    fun tearDown() {
        Locale.setDefault(originalDefaultLocale)
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
    fun upgradeWithSavedChoiceIsNeverOverriddenByInitializer() {
        // Same-signature upgrade: an older build saved an explicit choice (INIT_KEY not yet set).
        context.getSharedPreferences(AppLocale.PREFS, Context.MODE_PRIVATE).edit()
            .putString(AppLocale.KEY, "en").commit()

        AppLocale.ensureInitialized(context)
        if (Build.VERSION.SDK_INT >= 33) {
            // 13+: the system per-app locale is the source of truth; an empty list means the
            // user's effective choice is System — the initializer must NOT force vi on top.
            val locales = context.getSystemService(LocaleManager::class.java).applicationLocales
            assertTrue(locales.isEmpty)
            assertEquals("system", AppLocale.read(context))
        } else {
            // Android 12 and below: the saved preference wins — no forced vi.
            assertEquals("en", AppLocale.read(context))
        }
        simulateRestart()
        if (Build.VERSION.SDK_INT < 33) {
            assertEquals("en", AppLocale.read(context))
        }
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
            // Android 12 and below: a saved System choice means wrap() returns the base context
            // untouched (no locale override), so resources follow the system locale.
            assertTrue(AppLocale.wrap(context) === context)
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
        // wrap() must override the JVM default locale (consumed by SimpleDateFormat and friends)
        assertEquals("vi", Locale.getDefault().language)
        // ...and return a distinct wrapped context; a System choice must not wrap at all.
        assertTrue(wrapped !== context)

        AppLocale.apply(context, "system")
        assertTrue(AppLocale.wrap(context) === context)
    }
}
