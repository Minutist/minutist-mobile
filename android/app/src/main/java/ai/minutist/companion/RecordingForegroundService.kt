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
 * Foreground service that keeps the process alive for screen-off, long-duration
 * meeting recordings.
 *
 * This service owns exactly two things:
 *   1. An ongoing notification that satisfies the OS foreground-service contract.
 *   2. A PARTIAL_WAKE_LOCK so the CPU stays awake while the screen is off.
 *
 * Audio capture is entirely the responsibility of the @capgo/capacitor-audio-recorder
 * plugin. This service contains no audio-encoding, Opus, or ML code.
 *
 * Doze / 60-minute locked-screen acceptance: behaviour on real OEM handsets with
 * aggressive battery management (Huawei, Xiaomi, Samsung) is deferred to a manual
 * device spike. CI cannot exercise Doze survival.
 */
class RecordingForegroundService : Service() {

    private var wakeLock: WakeLock? = null

    companion object {
        private const val NOTIFICATION_ID = 1001
        private const val CHANNEL_ID_RES = R.string.recording_notification_channel_id
    }

    // -------------------------------------------------------------------------
    // Service lifecycle
    // -------------------------------------------------------------------------

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val channelId = getString(CHANNEL_ID_RES)
        ensureNotificationChannel(channelId)

        val notification = NotificationCompat.Builder(this, channelId)
            .setContentTitle(getString(R.string.recording_notification_title))
            .setContentText(getString(R.string.recording_notification_text))
            // Use a standard Android system icon so no trademark-reserved app
            // icon assets are needed here.
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        acquireWakeLock()

        return START_STICKY
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
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "ai.minutist.companion:RecordingWakeLock",
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
            getString(R.string.recording_notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.recording_notification_channel_description)
        }
        nm.createNotificationChannel(channel)
    }
}
