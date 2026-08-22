// SPDX-License-Identifier: AGPL-3.0-only
package ai.minutist.companion

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Unit tests for the relay-address rebuild decision (issue 0057).
 *
 * The engine takes its relay addresses at CONSTRUCTION and installs them as a
 * static resolver, so a device that changes network keeps dialling the address it
 * resolved on the old one — every dial then fails inside `dial_url`, before TLS,
 * until the app restarts. The network callback re-resolves; this is the predicate
 * deciding whether the (disruptive) engine rebuild is actually warranted.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SyncPluginRelayRebuildTest {
    private val plugin = SyncPlugin()

    @Test
    fun rebuilds_when_the_address_actually_changes() {
        assertTrue(
            plugin.shouldRebuildForRelayIps(listOf("220.233.46.218"), listOf("203.0.113.9")),
        )
    }

    @Test
    fun does_not_rebuild_when_the_address_is_unchanged() {
        assertFalse(
            plugin.shouldRebuildForRelayIps(listOf("220.233.46.218"), listOf("220.233.46.218")),
        )
    }

    @Test
    fun does_not_rebuild_on_reordering_only() {
        // A resolver may return the same set in a different order; rebuilding on
        // that would interrupt sync for no gain.
        assertFalse(
            plugin.shouldRebuildForRelayIps(
                listOf("198.51.100.1", "203.0.113.9"),
                listOf("203.0.113.9", "198.51.100.1"),
            ),
        )
    }

    @Test
    fun does_not_rebuild_when_resolution_failed() {
        // Empty means the new link could not resolve. The old addresses may still
        // work, so tearing the engine down would be strictly worse.
        assertFalse(plugin.shouldRebuildForRelayIps(listOf("220.233.46.218"), emptyList()))
    }

    @Test
    fun rebuilds_on_first_resolution_after_an_empty_start() {
        // Engine started with no addresses (cold-start resolve failed); the first
        // successful resolution should take effect.
        assertTrue(plugin.shouldRebuildForRelayIps(emptyList(), listOf("220.233.46.218")))
    }

    @Test
    fun does_not_rebuild_when_both_are_empty() {
        assertFalse(plugin.shouldRebuildForRelayIps(emptyList(), emptyList()))
    }
}
