package com.comapeo.core

import android.content.Context
import android.content.Intent

/**
 * Host-supplied wording for the foreground-service notification. A `null`
 * field means "use the `comapeo_core_notification_*` string resource".
 *
 * Own prefs file, written only by the main process: a commit rewrites the whole
 * file from the writer's in-memory copy, so a shared file would let the service
 * erase newer wording. The service reads it once at cold start; lifecycle
 * intents carry the current values after that.
 */
data class ServiceNotificationContent(
    val title: String? = null,
    val body: String? = null,
) {
    internal fun write(store: ComapeoPrefs.Store) =
        store.putStrings(mapOf(KEY_TITLE to title, KEY_BODY to body))

    fun applyTo(intent: Intent): Intent = intent
        .putExtra(KEY_TITLE, title)
        .putExtra(KEY_BODY, body)

    companion object {
        const val PREFS_NAME = "com.comapeo.core.notification"
        const val KEY_TITLE = "notification.title"
        const val KEY_BODY = "notification.body"

        /** Blank strings count as absent so a host can't post an empty notification. */
        fun of(title: String?, body: String?) = ServiceNotificationContent(
            title = title?.takeUnless { it.isBlank() },
            body = body?.takeUnless { it.isBlank() },
        )

        internal fun store(context: Context) = ComapeoPrefs.openStore(context, PREFS_NAME)

        internal fun read(store: ComapeoPrefs.Store) =
            of(store.getString(KEY_TITLE), store.getString(KEY_BODY))

        fun fromIntent(intent: Intent) =
            of(intent.getStringExtra(KEY_TITLE), intent.getStringExtra(KEY_BODY))
    }
}
