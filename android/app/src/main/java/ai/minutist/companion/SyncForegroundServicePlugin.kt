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
 * Capacitor plugin bridge for the sync foreground service.
 *
 * Exposes:
 *   - start(): raise the dataSync foreground service — called by the JS sync layer
 *     when the app is backgrounded while a sync is in flight, so the push can drain.
 *   - stop():  tear it down — called the moment the outbound queue drains.
 *
 * start() resolves `{ started: boolean }`: false when the OS refused to raise the
 * service (Android 12+ can throw ForegroundServiceStartNotAllowedException for a
 * background start), so the JS layer can fall back to a deferred retry rather than
 * assume the sync will survive.
 *
 * Owns only process-liveness + the transient notification. The wifi radio is held
 * by SyncPlugin's WifiLock across the same window; this plugin touches no network
 * or sync state. Matching TypeScript binding: src/sync/syncForegroundService.ts.
 */
@CapacitorPlugin(name = "SyncForegroundService")
class SyncForegroundServicePlugin : Plugin() {

    @PluginMethod
    fun start(call: PluginCall) {
        val intent = Intent(context, SyncForegroundService::class.java)
        val started = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
            true
        } catch (e: Exception) {
            // Most likely ForegroundServiceStartNotAllowedException (API 31+) on a
            // background start; report failure so JS defers instead of assuming
            // the push will survive backgrounding.
            false
        }
        call.resolve(JSObject().put("started", started))
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        context.stopService(Intent(context, SyncForegroundService::class.java))
        call.resolve(JSObject())
    }
}
