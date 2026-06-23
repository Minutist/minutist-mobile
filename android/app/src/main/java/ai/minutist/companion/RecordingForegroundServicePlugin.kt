// SPDX-License-Identifier: AGPL-3.0-only
package ai.minutist.companion

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Capacitor plugin bridge for the recording foreground service.
 *
 * Exposes three methods to the webview:
 *   - start(): raise the foreground service (called before recording begins)
 *   - stop():  tear down the foreground service (called after recording ends)
 *   - requestNotificationPermission(): prompt for POST_NOTIFICATIONS on API 33+
 *     so the ongoing recording notification is not silently suppressed
 *
 * The plugin owns only process-lifetime management. Audio capture is handled
 * exclusively by @capgo/capacitor-audio-recorder; this plugin does not encode
 * or process audio in any form.
 *
 * The matching TypeScript binding is in src/capture/foregroundService.ts.
 */
@CapacitorPlugin(name = "RecordingForegroundService")
class RecordingForegroundServicePlugin : Plugin() {

    @PluginMethod
    fun start(call: PluginCall) {
        val intent = Intent(context, RecordingForegroundService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
        call.resolve(JSObject())
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        val intent = Intent(context, RecordingForegroundService::class.java)
        context.stopService(intent)
        call.resolve(JSObject())
    }

    /**
     * Request POST_NOTIFICATIONS permission on Android 13+ (API 33+).
     *
     * On older API levels the permission is granted automatically and no prompt
     * is needed; this method resolves immediately with granted = true.
     *
     * The webview calls this alongside the RECORD_AUDIO prompt so both
     * permissions are requested in the same capture-start flow, satisfying the
     * Android requirement that runtime permissions be requested in context.
     *
     * Resolves with: { granted: boolean }
     */
    @PluginMethod
    fun requestNotificationPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            // Below API 33, POST_NOTIFICATIONS is not a runtime permission.
            val result = JSObject()
            result.put("granted", true)
            call.resolve(result)
            return
        }

        val permission = Manifest.permission.POST_NOTIFICATIONS
        if (ContextCompat.checkSelfPermission(context, permission) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            val result = JSObject()
            result.put("granted", true)
            call.resolve(result)
            return
        }

        ActivityCompat.requestPermissions(activity, arrayOf(permission), NOTIFICATION_PERM_CODE)

        // The result is delivered via onRequestPermissionsResult; we resolve
        // optimistically here.  If the user denies, the notification is simply
        // not shown — recording continues.  A follow-up call to the system
        // notification settings is the standard recovery path.
        val result = JSObject()
        result.put("granted", false)
        call.resolve(result)
    }

    companion object {
        private const val NOTIFICATION_PERM_CODE = 1002
    }
}
