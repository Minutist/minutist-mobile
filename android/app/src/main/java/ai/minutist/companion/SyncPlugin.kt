// SPDX-License-Identifier: AGPL-3.0-only
package ai.minutist.companion

import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.File
import uniffi.sync_ffi.FfiCaptureState
import uniffi.sync_ffi.FfiLifecycle
import uniffi.sync_ffi.FfiMeeting
import uniffi.sync_ffi.FfiSyncEngine
import uniffi.sync_ffi.LifecycleListener

/**
 * Capacitor plugin bridging the webview to the Rust sync engine
 * ([uniffi.sync_ffi.FfiSyncEngine], compiled from the desktop `crates/sync-ffi`).
 * The phone is just another paired iroh endpoint; this plugin is the thin
 * Kotlin ↔ UniFFI seam the real `SyncClient` (src/sync/capacitor.ts) calls.
 *
 * The FFI methods are blocking (they `block_on` the engine's own tokio runtime),
 * so every call runs on [Dispatchers.IO] — the same pattern OpusTranscodePlugin
 * uses — never the main thread. One engine is started once via [start]; inbound
 * discovery lifecycle events are forwarded to the webview as a `meetingsChanged`
 * event (the JS side re-snapshots via `listMeetings`).
 *
 * The matching TypeScript facade is src/sync/plugin.ts; the SyncClient impl over
 * it is src/sync/capacitor.ts.
 */
@CapacitorPlugin(name = "SyncFfi")
class SyncPlugin : Plugin() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** The started engine, or null before [start] / after [shutdown]. */
    private var engine: FfiSyncEngine? = null

    /** Absolute path of the per-meeting `{uuid}` folder root, for `audioUri`. */
    private var meetingsRoot: String = ""

    /**
     * Bind the iroh endpoint and start the accept loop. Idempotent: a second call
     * while already started is a no-op.
     *
     * Params: relayUrl (required), relayAuthToken (optional). The meetings root
     * and the device-key dir are the app's private files dir — the ed25519 key
     * never crosses into JS.
     */
    @PluginMethod
    fun start(call: PluginCall) {
        if (engine != null) {
            call.resolve()
            return
        }
        val relayUrl = call.getString("relayUrl")
            ?: return call.reject("relayUrl is required")
        val relayAuthToken = call.getString("relayAuthToken")

        scope.launch {
            try {
                val root = File(context.filesDir, "meetings").apply { mkdirs() }
                meetingsRoot = root.absolutePath
                engine = FfiSyncEngine.start(
                    relayUrl,
                    relayAuthToken,
                    meetingsRoot,
                    context.filesDir.absolutePath,
                ).also { eng ->
                    // Forward inbound lifecycle to the webview; the JS side
                    // re-snapshots the meeting list on each event.
                    eng.subscribeLifecycle(object : LifecycleListener {
                        override fun onLifecycle(meetingId: String, lifecycle: FfiLifecycle) {
                            notifyListeners("meetingsChanged", JSObject())
                        }
                        override fun onLagged() {
                            notifyListeners("meetingsChanged", JSObject())
                        }
                    })
                }
                call.resolve()
            } catch (e: Exception) {
                call.reject("sync start failed: ${e.message}", e)
            }
        }
    }

    @PluginMethod
    fun myTicket(call: PluginCall) = withEngine(call) { eng ->
        call.resolve(JSObject().put("ticket", eng.myTicket()))
    }

    @PluginMethod
    fun endpointId(call: PluginCall) = withEngine(call) { eng ->
        call.resolve(JSObject().put("endpointId", eng.endpointId()))
    }

    @PluginMethod
    fun pair(call: PluginCall) {
        val ticket = call.getString("ticket") ?: return call.reject("ticket is required")
        withEngine(call) { eng ->
            call.resolve(JSObject().put("peerId", eng.pair(ticket)))
        }
    }

    @PluginMethod
    fun peerIds(call: PluginCall) = withEngine(call) { eng ->
        call.resolve(JSObject().put("peerIds", JSArray(eng.peerIds())))
    }

    @PluginMethod
    fun localMeetings(call: PluginCall) = withEngine(call) { eng ->
        call.resolve(JSObject().put("meetingIds", JSArray(eng.localMeetings())))
    }

    /**
     * Persist a captured-unprocessed meeting. Params: title, startedAtMs, durationMs
     * (numbers), audioSrcPath (optional, a pre-materialised Opus file), notesText.
     */
    @PluginMethod
    fun saveCaptured(call: PluginCall) {
        val title = call.getString("title") ?: return call.reject("title is required")
        // Epoch-millis and durations are read as Long via the backing JSONObject,
        // not call.getDouble(): Capacitor's getDouble() only coerces Double / Float
        // / Integer, so a real Unix-ms timestamp (> 2^31, bridged as a JSON Long)
        // comes back null. optLong() coerces Long and Double alike.
        val data = call.getData()
        if (!data.has("startedAtMs")) return call.reject("startedAtMs is required")
        val startedAtMs = data.optLong("startedAtMs")
        val durationMs = data.optLong("durationMs", 0L)
        val audioSrcPath = call.getString("audioSrcPath")
        val notesText = call.getString("notesText") ?: ""
        withEngine(call) { eng ->
            val id = eng.saveCaptured(title, startedAtMs, durationMs, audioSrcPath, notesText)
            call.resolve(JSObject().put("id", id))
        }
    }

    @PluginMethod
    fun listMeetings(call: PluginCall) = withEngine(call) { eng ->
        val arr = JSArray()
        eng.listMeetings().forEach { arr.put(meetingToJs(it)) }
        call.resolve(JSObject().put("meetings", arr))
    }

    @PluginMethod
    fun getMeeting(call: PluginCall) {
        val id = call.getString("id") ?: return call.reject("id is required")
        withEngine(call) { eng ->
            val meeting = eng.getMeeting(id)
            call.resolve(JSObject().put("meeting", meeting?.let { meetingToJs(it) }))
        }
    }

    @PluginMethod
    fun syncNotes(call: PluginCall) {
        val peerId = call.getString("peerId") ?: return call.reject("peerId is required")
        val meetingId = call.getString("meetingId") ?: return call.reject("meetingId is required")
        withEngine(call) { eng ->
            eng.syncNotes(peerId, meetingId)
            call.resolve()
        }
    }

    @PluginMethod
    fun syncMedia(call: PluginCall) {
        val peerId = call.getString("peerId") ?: return call.reject("peerId is required")
        val meetingId = call.getString("meetingId") ?: return call.reject("meetingId is required")
        withEngine(call) { eng ->
            eng.syncMedia(peerId, meetingId)
            call.resolve()
        }
    }

    @PluginMethod
    fun discoverWith(call: PluginCall) {
        val peerId = call.getString("peerId") ?: return call.reject("peerId is required")
        withEngine(call) { eng ->
            call.resolve(JSObject().put("meetingIds", JSArray(eng.discoverWith(peerId))))
        }
    }

    @PluginMethod
    fun shutdown(call: PluginCall) {
        val eng = engine
        engine = null
        scope.launch {
            try {
                eng?.shutdown()
                call.resolve()
            } catch (e: Exception) {
                call.reject("sync shutdown failed: ${e.message}", e)
            }
        }
    }

    // -------------------------------------------------------------------------

    /** Run [block] with the started engine on the IO dispatcher, or reject. */
    private fun withEngine(call: PluginCall, block: (FfiSyncEngine) -> Unit) {
        val eng = engine ?: return call.reject("sync engine not started")
        scope.launch {
            try {
                block(eng)
            } catch (e: Exception) {
                call.reject(e.message ?: "sync call failed", e)
            }
        }
    }

    /** Project an [FfiMeeting] to the webview's Meeting shape (see types.ts). */
    private fun meetingToJs(m: FfiMeeting): JSObject = when (m) {
        is FfiMeeting.Captured -> JSObject().apply {
            put("state", "captured-unprocessed")
            put("id", m.id)
            put("title", m.title)
            put("startedAtMs", m.startedAtMs)
            put("durationMs", m.durationMs)
            put("hasNotes", m.hasNotes)
            put("processing", if (m.processing == FfiCaptureState.CLAIMED) "claimed" else "pending")
            m.claimedBy?.let { put("claimedBy", it) }
            // has_audio → the platform file URI (the plugin owns filesDir).
            if (m.hasAudio) put("audioUri", "file://$meetingsRoot/${m.id}/audio.opus")
        }
        is FfiMeeting.Synced -> JSObject().apply {
            put("state", "synced")
            put("id", m.id)
            put("title", m.title)
            put("startedAtMs", m.startedAtMs)
            val segs = JSArray()
            m.transcript.forEach { s ->
                segs.put(
                    JSObject()
                        .put("speakerIndex", s.speakerIndex.toLong())
                        .put("startMs", s.startMs)
                        .put("endMs", s.endMs)
                        .put("text", s.text)
                )
            }
            put("transcript", segs)
            m.summary?.let { put("summary", it) }
            put("speakers", JSArray(m.speakers))
            // Opaque Yjs v1 bytes → base64 for the JS boundary (decoded to a
            // Uint8Array in the SyncClient bridge).
            m.notes?.let { put("notesB64", Base64.encodeToString(it, Base64.NO_WRAP)) }
        }
    }
}
