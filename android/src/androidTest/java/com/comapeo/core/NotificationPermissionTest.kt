package com.comapeo.core

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented tests for [ComapeoCoreService.hasPostNotificationsPermission],
 * the runtime gate the foreground service consults before posting its
 * notification on Android 13+ (API 33). Runs on a device/emulator because
 * `checkSelfPermission` needs a real package-manager grant state.
 *
 * POST_NOTIFICATIONS only exists on API 33+, so `GrantPermissionRule` can't be
 * used — it throws "Unknown permission" on older levels, and CI runs API 30.
 * [mirrorsCheckSelfPermission] works on every level; [reportsGrantedWhenHeld]
 * self-skips below 33 and grants via UiAutomation only where the permission
 * exists.
 *
 * The JS wrappers in `src/ComapeoCoreModule.ts` are covered by
 * `src/__tests__/notification-permissions.test.js`.
 */
@RunWith(AndroidJUnit4::class)
class NotificationPermissionTest {

    private lateinit var context: Context

    @Before
    fun setUp() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
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

    @Test
    fun reportsGrantedWhenHeld() {
        assumeTrue(
            "POST_NOTIFICATIONS is a runtime permission only on API 33+",
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU,
        )
        InstrumentationRegistry.getInstrumentation().uiAutomation
            .grantRuntimePermission(
                context.packageName,
                Manifest.permission.POST_NOTIFICATIONS,
            )
        assertTrue(
            "Helper must report granted once POST_NOTIFICATIONS is held",
            ComapeoCoreService.hasPostNotificationsPermission(context),
        )
    }
}
