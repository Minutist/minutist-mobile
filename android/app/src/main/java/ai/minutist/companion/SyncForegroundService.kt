// SPDX-License-Identifier: AGPL-3.0-only
package ai.minutist.companion

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.PowerManager.WakeLock
import androidx.core.app.NotificationCompat

/**
 * Foreground service that keeps the process alive so an in-flight sync can finish
 * draining after the app is backgrounded mid-sync.
 *
 * Bounded to the sync window, NOT the app lifetime: the JS layer starts it only
 * when the app goes to the background while there is unsynced outbound data, and
 * stops it the moment the outbound queue drains — so its notification is transient
 * (seconds-to-minutes), never a permanent badge. In the common foreground case the
 * app never starts it, so no notification appears.
 *
 * It owns exactly two things:
 *   1. An ongoing notification satisfying the OS foreground-service contract.
 *   2. A PARTIAL_WAKE_LOCK so the CPU stays awake (and the sync engine's tokio
 *      runtime keeps servicing the connection) while the screen is off.
 *
 * The wifi radio is kept awake separately by SyncPlugin's WifiLock, held across the
 * same window; this service does not touch the network. `dataSync` is the correct
 * foreground-service type for a network data transfer (API 34+ requires a type).
 */
class SyncForegroundService : Service() {

    private var wakeLock: WakeLock? = null

    companion object {
        private const val NOTIFICATION_ID = 1003
        private const val CHANNEL_ID_RES = R.string.sync_notification_channel_id
    }

    // -------------------------------------------------------------------------
    // Service lifecycle
    // -------------------------------------------------------------------------

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val channelId = getString(CHANNEL_ID_RES)
        ensureNotificationChannel(channelId)

        val notification = NotificationCompat.Builder(this, channelId)
            .setContentTitle(getString(R.string.sync_notification_title))
            .setContentText(getString(R.string.sync_notification_text))
            // Standard system icon — no trademark-reserved app-icon asset needed here.
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        acquireWakeLock()

        // Not sticky: if the OS kills the process the sync is abandoned rather than
        // silently restarted without the webview's queue context; the JS layer
        // re-drives it on next launch / via the deferred retry.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        super.onDestroy()
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // -------------------------------------------------------------------------
    // Wake lock helpers
    // -------------------------------------------------------------------------

    private fun acquireWakeLock() {
        // Idempotent: a redelivered start intent must not orphan a held lock.
        if (wakeLock != null) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "ai.minutist.companion:SyncWakeLock",
        ).also { it.acquire() }
    }

    private fun releaseWakeLock() {
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
        wakeLock = null
    }

    // -------------------------------------------------------------------------
    // Notification channel
    // -------------------------------------------------------------------------

    private fun ensureNotificationChannel(channelId: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(channelId) != null) return
        val channel = NotificationChannel(
            channelId,
            getString(R.string.sync_notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.sync_notification_channel_description)
        }
        nm.createNotificationChannel(channel)
    }
}
