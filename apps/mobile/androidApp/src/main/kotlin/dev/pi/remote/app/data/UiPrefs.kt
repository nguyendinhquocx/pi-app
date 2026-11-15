package dev.pi.remote.app.data

import android.content.Context
import androidx.compose.runtime.staticCompositionLocalOf
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** Small per-device UI preferences: theme, language, inbox grouping, the project new chats go to. */
class UiPrefs(private val context: Context) {
    private val sp = context.getSharedPreferences("ui", Context.MODE_PRIVATE)

    private val _theme = MutableStateFlow(sp.getString("theme", "system") ?: "system")
    /** `system` | `light` | `dark` */
    val theme: StateFlow<String> = _theme
    fun setTheme(v: String) { _theme.value = v; sp.edit().putString("theme", v).apply() }

    private val _language = MutableStateFlow(AppLocale.read(context))
    /** `system` | `en` | `zh` | `vi` */
    val language: StateFlow<String> = _language
    /** Returns true when the caller must recreate the activity itself (Android 12 and older). */
    fun setLanguage(v: String): Boolean {
        if (v == _language.value) return false
        _language.value = v
        AppLocale.apply(context, v)
        return android.os.Build.VERSION.SDK_INT < 33
    }

    private val _grouping = MutableStateFlow(sp.getString("grouping", "status") ?: "status")
    /** `status` | `project` */
    val grouping: StateFlow<String> = _grouping
    fun setGrouping(v: String) { _grouping.value = v; sp.edit().putString("grouping", v).apply() }

    /** Asked once for POST_NOTIFICATIONS (Android 13+), on the first send. */
    var askedNotifications: Boolean
        get() = sp.getBoolean("askedNotif", false)
        set(v) { sp.edit().putBoolean("askedNotif", v).apply() }

    private val _recentModels = MutableStateFlow(
        sp.getString("recentModels", null).orEmpty().split('\n').filter { it.isNotBlank() },
    )

    /** Recently picked models (full `provider/id` ids), newest first — mirrors the desktop picker. */
    val recentModels: StateFlow<List<String>> = _recentModels

    /** Moves [id] to the front of the recents list, capped at [RECENT_MODELS_LIMIT]. */
    fun rememberModel(id: String) {
        val next = (listOf(id) + _recentModels.value.filter { it != id }).take(RECENT_MODELS_LIMIT)
        _recentModels.value = next
        sp.edit().putString("recentModels", next.joinToString("\n")).apply()
    }

    private val _notifyComplete = MutableStateFlow(sp.getBoolean("notifyComplete", true))

    /** Post a notification when a session finishes outside the app (Settings toggle, default on). */
    val notifyComplete: StateFlow<Boolean> = _notifyComplete
    fun setNotifyComplete(v: Boolean) { _notifyComplete.value = v; sp.edit().putBoolean("notifyComplete", v).apply() }

    var lastProject: String?
        get() = sp.getString("lastProject", null)
        set(v) { sp.edit().putString("lastProject", v).apply() }

    companion object {
        const val RECENT_MODELS_LIMIT = 5
    }
}

val LocalUiPrefs = staticCompositionLocalOf<UiPrefs?> { null }
