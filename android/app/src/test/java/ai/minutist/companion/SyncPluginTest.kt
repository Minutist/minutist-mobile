// SPDX-License-Identifier: AGPL-3.0-only
package ai.minutist.companion

import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Robolectric unit tests for the SyncPlugin, focusing on the seed-credential
 * injection path for DEBUG builds.
 *
 * The seed credential allows automated e2e runs to inject a pre-minted device
 * credential via the launch intent, bypassing the interactive device-code sign-in
 * flow. The credential is stored once via the plugin's getSeedCredential accessor,
 * then written to encrypted storage by the JS side.
 *
 * Full sync integration (starting the engine, wiring lifecycle listeners,
 * managing iroh connections) requires native FFI bindings and is covered by
 * on-device e2e validation (e2e/run-on-step.sh), not by these JVM unit tests.
 *
 * API 35 (VANILLA_ICE_CREAM) is the maximum SDK supported by Robolectric 4.14.1;
 * compileSdk/targetSdk are 36 so @Config must pin an explicit SDK or the runner
 * throws IllegalArgumentException at init time.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [Build.VERSION_CODES.VANILLA_ICE_CREAM])
class SyncPluginTest {

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /** Build a plugin with the debug gate forced open so the seed path is reachable. */
    private fun debugPlugin(): SyncPlugin = SyncPlugin().also { it.debugOverride = true }

    private fun captureCall(tag: String, onResolve: (JSObject?) -> Unit): PluginCall =
        object : PluginCall(null, "SyncFfi", tag, "getSeedCredential", JSObject()) {
            override fun resolve(obj: JSObject?) = onResolve(obj)
            override fun reject(message: String?, code: String?, ex: Exception?) {}
        }

    // -------------------------------------------------------------------------
    // Seed-credential injection (DEBUG builds only)
    // -------------------------------------------------------------------------

    /**
     * Verify that the seed credential is populated from the MainActivity's
     * launch intent and is returned via getSeedCredential once, then consumed.
     */
    @Test
    fun `getSeedCredential returns the injected seed once, then null`() {
        val plugin = debugPlugin()
        val seed = "mdc_test_injected.secret123"
        plugin.pendingSeed = seed

        // First call returns the seed.
        var result1: String? = null
        plugin.getSeedCredential(captureCall("cb1") { result1 = it?.getString("seed") })
        assertEquals(
            "First getSeedCredential call must return the injected seed",
            seed,
            result1,
        )

        // Second call: seed is null after consumption.
        // JSObject.put("seed", null) stores a JSON null; getString returns null.
        var result2: String? = "sentinel"
        plugin.getSeedCredential(captureCall("cb2") { result2 = it?.getString("seed") })
        assertNull(
            "Second getSeedCredential call must return null (seed consumed)",
            result2,
        )
    }

    /**
     * Verify that getSeedCredential is safe when no seed is injected
     * (the normal sign-in flow).
     */
    @Test
    fun `getSeedCredential returns null when no seed was injected`() {
        val plugin = debugPlugin()
        // pendingSeed is null by default

        // JSObject.put("seed", null) stores a JSON null; getString returns null.
        var result: String? = "sentinel"
        plugin.getSeedCredential(captureCall("cb3") { result = it?.getString("seed") })
        assertNull(
            "getSeedCredential must return null when no seed is set",
            result,
        )
    }

    /**
     * Verify that getSeedCredential handles the empty-string case (redundant,
     * but consistent with MainActivity's check).
     */
    @Test
    fun `getSeedCredential returns empty string if explicitly set to empty`() {
        val plugin = debugPlugin()
        plugin.pendingSeed = ""

        // Empty string round-trips through JSObject; getString returns "".
        var result: String? = null
        plugin.getSeedCredential(captureCall("cb4") { result = it?.getString("seed") })
        assertEquals(
            "Empty seed is stored as-is",
            "",
            result,
        )
    }

    // -------------------------------------------------------------------------
    // Wifi lock lifecycle
    //
    // The lock is acquired for the engine's lifetime by start() and released by
    // shutdown(); start()/shutdown() themselves need the native FFI (covered
    // on-device), so the lock mechanics are exercised directly via the
    // @VisibleForTesting acquire/release helpers with Robolectric's shadow
    // WifiManager.
    // -------------------------------------------------------------------------

    @Test
    fun `acquireWifiLock holds a lock and is idempotent`() {
        val app = RuntimeEnvironment.getApplication()
        val plugin = SyncPlugin()
        assertFalse("No lock before acquire", plugin.isWifiLockHeld())

        plugin.acquireWifiLock(app)
        assertTrue("Lock must be held after acquire", plugin.isWifiLockHeld())

        // A redundant acquire (e.g. an idempotent second start) must be a no-op,
        // not a second orphaned lock.
        plugin.acquireWifiLock(app)
        assertTrue("Lock must still be held after a redundant acquire", plugin.isWifiLockHeld())
    }

    @Test
    fun `releaseWifiLock releases the lock and is idempotent`() {
        val app = RuntimeEnvironment.getApplication()
        val plugin = SyncPlugin()
        plugin.acquireWifiLock(app)
        assertTrue("Lock held before release", plugin.isWifiLockHeld())

        plugin.releaseWifiLock()
        assertFalse("Lock must be released", plugin.isWifiLockHeld())

        // A redundant release (e.g. shutdown after a failed start already released)
        // must not throw.
        plugin.releaseWifiLock()
        assertFalse("Lock must stay released after a redundant release", plugin.isWifiLockHeld())
    }

    // -------------------------------------------------------------------------
    // Relay host parsing (the host fed to the system resolver for relay_ips)
    // -------------------------------------------------------------------------

    @Test
    fun `relayHost parses the host from a relay URL`() {
        val plugin = SyncPlugin()
        assertEquals("sync.minutist.ai", plugin.relayHost("https://sync.minutist.ai"))
        assertEquals("sync.minutist.ai", plugin.relayHost("https://sync.minutist.ai/relay"))
        // Unparseable input yields null → resolveRelayIps returns empty → DoH fallback.
        assertNull("garbage input yields null", plugin.relayHost("not a url"))
    }
}
