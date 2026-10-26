package com.comapeo.core

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented tests for what the foreground-service notification looks like
 * to the user: its channel never badges the launcher icon or makes a sound,
 * and the notification carries the host's wording (with resource fallbacks)
 * and no actions. The channel case assumes a fresh install: Android freezes
 * channel attributes once created, so on a dev device that has an older
 * channel it reflects that install, not this code.
 */
@RunWith(AndroidJUnit4::class)
class ServiceNotificationTest {

    private lateinit var context: Context

    @Before
    fun setUp() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
    }

    @Test
    fun channelIsSilentAndNeverBadges() {
        assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
        ComapeoCoreService.ensureNotificationChannel(context)

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = manager.getNotificationChannel(ComapeoCoreService.CHANNEL_ID)
        assertFalse("FGS channel must not badge the launcher icon", channel.canShowBadge())
        assertEquals(NotificationManager.IMPORTANCE_LOW, channel.importance)
        assertNull(channel.sound)
        assertEquals(context.getString(R.string.comapeo_core_notification_channel_name), channel.name)
    }

    @Test
    fun notificationShowsHostWordingWithResourceFallbackAndNoActions() {
        val notification = ComapeoCoreService.buildNotification(
            context,
            ServiceNotificationContent.of(title = "Host title", body = null),
        )
        assertEquals("Host title", notification.extras.getCharSequence(Notification.EXTRA_TITLE).toString())
        assertEquals(
            context.getString(R.string.comapeo_core_notification_body),
            notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString(),
        )
        assertTrue(notification.actions.isNullOrEmpty())
        assertNotEquals(0, notification.flags and Notification.FLAG_ONGOING_EVENT)
    }
}
