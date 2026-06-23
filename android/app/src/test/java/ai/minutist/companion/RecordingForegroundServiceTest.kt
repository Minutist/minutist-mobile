// SPDX-License-Identifier: AGPL-3.0-only
package ai.minutist.companion

import android.app.Notification
import android.content.pm.ServiceInfo
import android.os.Build
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowPowerManager

/**
 * JVM unit tests for RecordingForegroundService using Robolectric.
 *
 * Covers:
 *   - Service starts in the foreground with an ongoing notification.
 *   - foregroundServiceType includes FOREGROUND_SERVICE_TYPE_MICROPHONE (API 29+).
 *   - PARTIAL_WAKE_LOCK is acquired on start.
 *   - PARTIAL_WAKE_LOCK is released on stop.
 *   - Redelivered start commands do not orphan a prior wake lock (idempotency).
 *   - Service stops cleanly.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [Build.VERSION_CODES.UPSIDE_DOWN_CAKE]) // API 34 — within compileSdk 36 window
class RecordingForegroundServiceTest {

    @Before
    fun setUp() {
        // Clear any wake locks left over from a previous test.
        ShadowPowerManager.clearWakeLocks()
    }

    // -------------------------------------------------------------------------
    // Foreground + notification
    // -------------------------------------------------------------------------

    @Test
    fun `service starts in foreground with an ongoing notification`() {
        val controller = Robolectric.buildService(RecordingForegroundService::class.java)
        controller.startCommand(0, 1)

        val shadow = Shadows.shadowOf(controller.get())
        val notification = shadow.lastForegroundNotification
        assertNotNull("Service must post a foreground notification on start", notification)
        assertTrue(
            "Notification must carry FLAG_ONGOING_EVENT",
            (notification!!.flags and Notification.FLAG_ONGOING_EVENT) != 0,
        )
        assertTrue(
            "Notification must be attached (service is in foreground)",
            shadow.isLastForegroundNotificationAttached,
        )
    }

    @Test
    fun `foreground service type includes microphone on API 29+`() {
        val controller = Robolectric.buildService(RecordingForegroundService::class.java)
        controller.startCommand(0, 1)

        // On API 29+ startForeground(id, notification, type) is called.
        // Service.getForegroundServiceType() is available on the real object at API 29+
        // (Robolectric intercepts it via ShadowService).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val type = controller.get().foregroundServiceType
            assertTrue(
                "Foreground service type must include FOREGROUND_SERVICE_TYPE_MICROPHONE",
                (type and ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE) != 0,
            )
        }
    }

    // -------------------------------------------------------------------------
    // Wake lock lifecycle
    // -------------------------------------------------------------------------

    @Test
    fun `PARTIAL_WAKE_LOCK is acquired on start`() {
        val controller = Robolectric.buildService(RecordingForegroundService::class.java)
        controller.startCommand(0, 1)

        val wakeLock = ShadowPowerManager.getLatestWakeLock()
        assertNotNull("A wake lock must be acquired after start", wakeLock)
        // isHeld() is intercepted transparently by Robolectric on the real WakeLock object.
        assertTrue("Acquired wake lock must be held", wakeLock!!.isHeld)
    }

    @Test
    fun `PARTIAL_WAKE_LOCK tag is correct`() {
        val controller = Robolectric.buildService(RecordingForegroundService::class.java)
        controller.startCommand(0, 1)

        val wakeLock = ShadowPowerManager.getLatestWakeLock()
        assertNotNull(wakeLock)
        // Robolectric exposes the tag via ShadowWakeLock.getTag() which is public.
        val shadowWakeLock = Shadows.shadowOf(wakeLock)
        val tag = shadowWakeLock.tag
        assertTrue(
            "Wake lock tag must identify this service",
            tag.contains("RecordingWakeLock"),
        )
    }

    @Test
    fun `PARTIAL_WAKE_LOCK is released on stop`() {
        val controller = Robolectric.buildService(RecordingForegroundService::class.java)
        controller.startCommand(0, 1)

        val wakeLock = ShadowPowerManager.getLatestWakeLock()
        assertNotNull("Wake lock must exist before stop", wakeLock)
        assertTrue("Wake lock must be held before stop", wakeLock!!.isHeld)

        controller.destroy()

        assertFalse(
            "Wake lock must be released after service is destroyed",
            wakeLock.isHeld,
        )
    }

    @Test
    fun `redelivered start command does not orphan wake lock`() {
        val controller = Robolectric.buildService(RecordingForegroundService::class.java)
        // First delivery.
        controller.startCommand(0, 1)
        val firstWakeLock = ShadowPowerManager.getLatestWakeLock()
        assertNotNull(firstWakeLock)
        assertTrue("First wake lock must be held", firstWakeLock!!.isHeld)

        // Redelivered start (START_STICKY — OS re-sends the intent after restart).
        controller.startCommand(0, 2)

        // The idempotency guard means the service skips acquireWakeLock; no new lock orphaned.
        val latestWakeLock = ShadowPowerManager.getLatestWakeLock()
        assertTrue("Wake lock must still be held after redelivered start", latestWakeLock!!.isHeld)

        // Destroying must release cleanly without an IllegalStateException.
        controller.destroy()

        assertFalse(
            "Wake lock must be released after destroy, even after redelivered start",
            latestWakeLock.isHeld,
        )
    }

    // -------------------------------------------------------------------------
    // Clean stop
    // -------------------------------------------------------------------------

    @Test
    fun `service stops cleanly and removes foreground notification`() {
        val controller = Robolectric.buildService(RecordingForegroundService::class.java)
        controller.startCommand(0, 1)

        // Must not throw.
        controller.destroy()

        val shadow = Shadows.shadowOf(controller.get())
        assertFalse(
            "Foreground must be stopped after destroy",
            shadow.isLastForegroundNotificationAttached,
        )
    }
}
