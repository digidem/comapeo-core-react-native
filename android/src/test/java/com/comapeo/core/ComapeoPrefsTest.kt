package com.comapeo.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * JVM-only unit tests for [ComapeoPrefs]. Uses the constructor's
 * lambda seam so we don't depend on a real `SharedPreferences`
 * (unmocked on the JVM unit-test classpath). Same pattern as
 * [SentryConfigTest] and [ControlFrameTest].
 *
 * Coverage rationale: this is the privacy toggle's persistence
 * layer. A regression that loses or mis-merges the default-fallback
 * would either disable diagnostics on devices that should have it
 * (bug-blindness) or enable it on devices that opted out (privacy
 * regression). Both are silent if the tests don't catch them.
 */
class ComapeoPrefsTest {

    /** Backing HashMap stand-in for the SharedPreferences file. */
    private class FakeStore {
        private val data = mutableMapOf<String, Boolean>()
        val read: (String) -> Boolean? = { key -> data[key] }
        val write: (String, Boolean) -> Unit = { key, value -> data[key] = value }
        fun has(key: String) = data.containsKey(key)
    }

    private fun prefs(
        store: FakeStore,
        diagnosticsDefault: Boolean = ComapeoPrefs.DEFAULT_DIAGNOSTICS_ENABLED,
        captureDefault: Boolean = ComapeoPrefs.DEFAULT_CAPTURE_APPLICATION_DATA,
    ): ComapeoPrefs = ComapeoPrefs(
        readBool = store.read,
        writeBool = store.write,
        defaults = ComapeoPrefs.Defaults(
            diagnosticsEnabled = diagnosticsDefault,
            captureApplicationData = captureDefault,
        ),
    )

    @Test
    fun bakedDefaultWhenKeyAbsent() {
        // Fresh install, plugin didn't ship a default, user hasn't
        // toggled anything — diagnostics on, capture-app-data off.
        val p = prefs(FakeStore())
        assertTrue(p.readDiagnosticsEnabled())
        assertFalse(p.readCaptureApplicationData())
    }

    @Test
    fun pluginDefaultOverridesBakedWhenKeyAbsent() {
        // E.g. a dev/qa plugin config with both flags on by default.
        val p = prefs(
            FakeStore(),
            diagnosticsDefault = false,
            captureDefault = true,
        )
        assertFalse(p.readDiagnosticsEnabled())
        assertTrue(p.readCaptureApplicationData())
    }

    @Test
    fun userValueWinsOverDefault() {
        // Once written, the user's choice persists across cold
        // starts regardless of what the plugin default says.
        val store = FakeStore()
        val p = prefs(
            store,
            diagnosticsDefault = true,
            captureDefault = false,
        )
        p.writeDiagnosticsEnabled(false)
        p.writeCaptureApplicationData(true)
        assertFalse(p.readDiagnosticsEnabled())
        assertTrue(p.readCaptureApplicationData())
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
            "sentry.captureApplicationData",
            ComapeoPrefs.KEY_CAPTURE_APPLICATION_DATA,
        )
    }

    @Test
    fun prefsFileNameIsPinned() {
        // Phase 6 plans to share this file. Pin the name so it can't
        // be renamed without a deliberate, visible change.
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
