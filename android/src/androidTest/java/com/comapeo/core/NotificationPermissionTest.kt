package com.comapeo.core

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented tests for [ComapeoCoreService.hasPostNotificationsPermission],
 * the runtime gate the foreground service consults before posting its
 * notification on Android 13+ (API 33). Runs on a device/emulator because
 * `checkSelfPermission` needs a real package-manager grant state.
 *
 * The JS wrappers in `src/ComapeoCoreModule.ts` are covered by
 * `src/__tests__/notification-permissions.test.js`; this pins the native
 * grant-state contract those wrappers ultimately surface.
 */
@RunWith(AndroidJUnit4::class)
class NotificationPermissionTest {

    // Force-grants POST_NOTIFICATIONS on API 33+; a no-op on older levels
    // where it's auto-granted at install. Either way the helper must agree.
    @get:Rule
    val grantRule: GrantPermissionRule =
        GrantPermissionRule.grant(Manifest.permission.POST_NOTIFICATIONS)

    private lateinit var context: Context

    @Before
    fun setUp() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
    }

    @Test
    fun reportsGrantedWhenPermissionHeld() {
        assertTrue(
            "Helper must report granted once POST_NOTIFICATIONS is held",
            ComapeoCoreService.hasPostNotificationsPermission(context),
        )
    }

    @Test
    fun mirrorsCheckSelfPermission() {
        val expected = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
        assertEquals(
            "Helper must reflect the platform checkSelfPermission verdict",
            expected,
            ComapeoCoreService.hasPostNotificationsPermission(context),
        )
    }
}
