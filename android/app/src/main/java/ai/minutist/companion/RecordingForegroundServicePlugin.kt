// SPDX-License-Identifier: AGPL-3.0-only
package ai.minutist.companion

import android.content.Intent
import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Capacitor plugin bridge for the recording foreground service.
 *
 * Exposes two methods to the webview:
 *   - start(): raise the foreground service (called before recording begins)
 *   - stop():  tear down the foreground service (called after recording ends)
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
}
