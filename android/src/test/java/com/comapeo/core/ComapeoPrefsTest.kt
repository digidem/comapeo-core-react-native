package com.comapeo.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * JVM-only unit tests for [ComapeoPrefs]. Backs the [ComapeoPrefs.Store]
 * seam with an in-memory map so we don't depend on a real
 * `SharedPreferences` (unmocked on the JVM unit-test classpath). Same
 * pattern as [SentryConfigTest] and [ControlFrameTest].
 *
 * Coverage rationale: this is the privacy toggle's persistence
 * layer. A regression that loses or mis-merges the default-fallback
 * would either disable diagnostics on devices that should have it
 * (bug-blindness) or enable it on devices that opted out (privacy
 * regression). Both are silent if the tests don't catch them.
 */
class ComapeoPrefsTest {

    /** In-memory [ComapeoPrefs.Store] stand-in for the SharedPreferences file. */
    private class FakeStore : ComapeoPrefs.Store {
        private val bools = mutableMapOf<String, Boolean>()
        private val longs = mutableMapOf<String, Long>()
        override fun getBoolean(key: String): Boolean? = bools[key]
        override fun putBoolean(key: String, value: Boolean) { bools[key] = value }
        override fun getLong(key: String): Long? = longs[key]
        override fun putLong(key: String, value: Long) { longs[key] = value }
        override fun remove(key: String) { bools.remove(key); longs.remove(key) }
        fun has(key: String) = bools.containsKey(key) || longs.containsKey(key)
    }

    private fun prefs(
        store: FakeStore,
        diagnosticsDefault: Boolean = ComapeoPrefs.DEFAULT_DIAGNOSTICS_ENABLED,
        usageDefault: Boolean = ComapeoPrefs.DEFAULT_APPLICATION_USAGE_DATA,
        debugDefault: Boolean = ComapeoPrefs.DEFAULT_DEBUG,
        now: () -> Long = { 0L },
    ): ComapeoPrefs = ComapeoPrefs(
        store = store,
        defaults = ComapeoPrefs.Defaults(
            diagnosticsEnabled = diagnosticsDefault,
            applicationUsageData = usageDefault,
            debug = debugDefault,
        ),
        now = now,
    )

    @Test
    fun bakedDefaultWhenKeyAbsent() {
        // Fresh install, plugin didn't ship a default, user hasn't
        // toggled anything — diagnostics on, usage off, debug off.
        val p = prefs(FakeStore())
        assertTrue(p.readDiagnosticsEnabled())
        assertFalse(p.readApplicationUsageData())
        assertFalse(p.readDebugEnabled())
    }

    @Test
    fun pluginDefaultOverridesBakedWhenKeyAbsent() {
        // E.g. a dev/qa plugin config with usage on by default.
        val p = prefs(
            FakeStore(),
            diagnosticsDefault = false,
            usageDefault = true,
        )
        assertFalse(p.readDiagnosticsEnabled())
        assertTrue(p.readApplicationUsageData())
    }

    @Test
    fun userValueWinsOverDefault() {
        // Once written, the user's choice persists across cold
        // starts regardless of what the plugin default says.
        val store = FakeStore()
        val p = prefs(
            store,
            diagnosticsDefault = true,
            usageDefault = false,
        )
        p.writeDiagnosticsEnabled(false)
        p.writeApplicationUsageData(true)
        assertFalse(p.readDiagnosticsEnabled())
        assertTrue(p.readApplicationUsageData())
    }

    @Test
    fun debugAutoOffBoundaries() {
        // fresh enable true; just within window true; just past window false + cleared.
        val store = FakeStore()
        var clock = 1_000_000L
        val p = prefs(store, now = { clock })
        p.writeDebugEnabled(true)
        assertTrue("fresh enable reads true", p.readDebugEnabled())

        clock += ComapeoPrefs.DEBUG_MAX_AGE_MS - 60_000 // one minute before expiry
        assertTrue("within window reads true", p.readDebugEnabled())

        clock += 120_000 // now past the window since enable
        assertFalse("past window auto-disables", p.readDebugEnabled())
        assertFalse(
            "auto-off clears the value",
            store.getBoolean(ComapeoPrefs.KEY_DEBUG)!!,
        )
        assertFalse(
            "auto-off clears the timestamp",
            store.has(ComapeoPrefs.KEY_DEBUG_ENABLED_AT_MS),
        )
        // A second read does not mutate further.
        assertFalse(p.readDebugEnabled())
    }

    @Test
    fun debugExpiresWhenClockMovesBackwardPastEnable() {
        // Backward wall-clock change must not extend debug: an enable
        // timestamp in the future (age < 0) auto-disables rather than
        // keeping debug on indefinitely.
        val store = FakeStore()
        var clock = 10_000_000L
        val p = prefs(store, now = { clock })
        p.writeDebugEnabled(true)
        assertTrue(p.readDebugEnabled())

        clock -= 5_000_000L // clock moved back before the enable stamp
        assertFalse("backward clock past enable auto-disables", p.readDebugEnabled())
        assertFalse(store.has(ComapeoPrefs.KEY_DEBUG_ENABLED_AT_MS))
    }

    @Test
    fun debugReEnableRefreshesWindow() {
        val store = FakeStore()
        var clock = 0L
        val p = prefs(store, now = { clock })
        p.writeDebugEnabled(true)
        clock += ComapeoPrefs.DEBUG_MAX_AGE_MS - 60_000
        // Re-enable just before expiry → fresh full window.
        p.writeDebugEnabled(true)
        clock += ComapeoPrefs.DEBUG_MAX_AGE_MS - 60_000
        assertTrue("re-enable should reset the window clock", p.readDebugEnabled())
    }

    @Test
    fun debugTrueWithoutTimestampStampsAndStaysOn() {
        // Older install: debug=true cell exists, no timestamp. Treat as
        // "enabled now" and stamp on first read.
        val store = FakeStore()
        store.putBoolean(ComapeoPrefs.KEY_DEBUG, true)
        val p = prefs(store, now = { 500L })
        assertTrue(p.readDebugEnabled())
        assertEquals(500L, store.getLong(ComapeoPrefs.KEY_DEBUG_ENABLED_AT_MS))
    }

    @Test
    fun writeFalsePersistsExplicitlyNotJustClears() {
        // Defensive: a regression that "clears the key on write false"
        // would silently re-enable diagnostics by falling back to the
        // baked-in default. The key must be present with `false`.
        val store = FakeStore()
        val p = prefs(store, diagnosticsDefault = true)
        p.writeDiagnosticsEnabled(false)
        assertTrue(
            "false write must persist the key, not delete it",
            store.has(ComapeoPrefs.KEY_DIAGNOSTICS_ENABLED),
        )
        assertFalse(p.readDiagnosticsEnabled())
    }

    @Test
    fun keysAreNamespaced() {
        // Pin the storage key names so we don't accidentally rename
        // them in a future refactor (which would orphan every
        // user's saved choice on update).
        assertEquals(
            "sentry.diagnosticsEnabled",
            ComapeoPrefs.KEY_DIAGNOSTICS_ENABLED,
        )
        assertEquals(
            "sentry.applicationUsageData",
            ComapeoPrefs.KEY_APPLICATION_USAGE_DATA,
        )
        assertEquals("sentry.debug", ComapeoPrefs.KEY_DEBUG)
    }

    @Test
    fun prefsFileNameIsPinned() {
        // Other code may come to share this prefs file. Pin the name
        // so it can't be renamed without a deliberate, visible change.
        assertEquals("com.comapeo.core.prefs", ComapeoPrefs.PREFS_NAME)
    }

    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test
    fun wipeSentryOutboxRemovesDirectory() {
        // Privacy-load-bearing: a regression that silently no-ops
        // this delete (wrong path constant, swallowed permission
        // error, etc.) would leave queued events on disk that the
        // next launch would re-ship even though the user opted out.
        val sentryDir = tempFolder.newFolder("sentry")
        File(sentryDir, "envelopes").mkdirs()
        File(sentryDir, "envelopes/123.envelope").writeText("payload")
        File(sentryDir, "sessions").mkdirs()
        File(sentryDir, "sessions/current.json").writeText("{}")
        assertTrue("setup: sentry dir should exist", sentryDir.exists())

        ComapeoPrefs.wipeSentryOutboxAt(sentryDir)

        assertFalse(
            "wipe must recursively remove the sentry dir",
            sentryDir.exists(),
        )
    }

    @Test
    fun wipeSentryOutboxIsNoOpWhenAbsent() {
        // First-run / already-wiped path: a missing directory is
        // success, not an error. The KDoc promises "best-effort" —
        // verify that absence doesn't throw.
        val missing = File(tempFolder.root, "sentry")
        assertFalse("setup: dir should be absent", missing.exists())
        ComapeoPrefs.wipeSentryOutboxAt(missing) // must not throw
        assertFalse(missing.exists())
    }
}
