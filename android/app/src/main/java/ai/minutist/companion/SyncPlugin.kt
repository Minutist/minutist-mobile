// SPDX-License-Identifier: AGPL-3.0-only
package ai.minutist.companion

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.util.Base64
import android.util.Log
import androidx.annotation.VisibleForTesting
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
import java.net.InetAddress
import java.net.URI
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

    /**
     * A wifi lock held for the engine's whole lifetime (see [acquireWifiLock]).
     * Null before [start] / after [shutdown].
     */
    private var wifiLock: WifiManager.WifiLock? = null

    /**
     * Credential seed injected at launch via the `minutist_seed_credential`
     * Intent extra. Set once by [MainActivity] before the bridge starts; read
     * once by the webview via [getSeedCredential] so JS can write it into
     * Keystore-encrypted storage before any sync call runs. Only populated in
     * DEBUG builds.
     *
     * Distinct name from the [getSeedCredential] bridge method (which reads and
     * clears it); public so MainActivity can set it from the launch intent.
     */
    public var pendingSeed: String? = null

    /**
     * Test-only override for the DEBUG gate in [getSeedCredential]. When null
     * (the default), the gate reads [BuildConfig.DEBUG] directly. Tests set
     * this to `true` to exercise the seed path without requiring a real debug
     * build config on the Robolectric classpath.
     *
     * Must NOT be set in production code.
     */
    @set:VisibleForTesting
    @get:VisibleForTesting
    internal var debugOverride: Boolean? = null

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
                // Hold the wifi radio at full power for the engine's lifetime BEFORE
                // binding the endpoint, so the relay connection is not idle-dropped by
                // wifi power-save. Released again if the start below throws.
                acquireWifiLock(context)
                val root = File(context.filesDir, "meetings").apply { mkdirs() }
                meetingsRoot = root.absolutePath
                engine = FfiSyncEngine.start(
                    relayUrl,
                    relayAuthToken,
                    meetingsRoot,
                    context.filesDir.absolutePath,
                    resolveRelayIps(context, relayUrl),
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
                // A failed start must not strand the wifi lock.
                releaseWifiLock()
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

    /**
     * Pull the derived artifacts (transcript.json / summary.md) for a meeting from
     * a paired peer. The Artifacts exchange reconciles bidirectionally, so the
     * phone receives any of the peer's artifacts that supersede its own. Used to
     * fetch results the phone missed if it was offline when the host pushed.
     */
    @PluginMethod
    fun syncArtifacts(call: PluginCall) {
        val peerId = call.getString("peerId") ?: return call.reject("peerId is required")
        val meetingId = call.getString("meetingId") ?: return call.reject("meetingId is required")
        withEngine(call) { eng ->
            eng.syncArtifacts(peerId, meetingId)
            call.resolve()
        }
    }

    /**
     * Register an iroh endpoint from the account directory as a peer so the
     * engine can connect to it directly. Corresponds to [FfiSyncEngine.addAccountPeer].
     * In-memory, synchronous, and idempotent (de-duped by endpoint id on the Rust side).
     *
     * Params: endpointId (required), relayUrl (required).
     */
    @PluginMethod
    fun addAccountPeer(call: PluginCall) {
        val endpointId = call.getString("endpointId") ?: return call.reject("endpointId is required")
        val relayUrl = call.getString("relayUrl") ?: return call.reject("relayUrl is required")
        withEngine(call) { eng ->
            eng.addAccountPeer(endpointId, relayUrl)
            call.resolve()
        }
    }

    /**
     * Remove an account-sourced peer that has left the account. Source-aware on the
     * Rust side: only `Account`-tagged peers are removed, never a manually paired
     * one.
     *
     * Params: endpointId (required). Returns: { removed: Boolean }.
     */
    @PluginMethod
    fun removeAccountPeer(call: PluginCall) {
        val endpointId = call.getString("endpointId") ?: return call.reject("endpointId is required")
        withEngine(call) { eng ->
            call.resolve(JSObject().put("removed", eng.removeAccountPeer(endpointId)))
        }
    }

    @PluginMethod
    fun discoverWith(call: PluginCall) {
        val peerId = call.getString("peerId") ?: return call.reject("peerId is required")
        withEngine(call) { eng ->
            call.resolve(JSObject().put("meetingIds", JSArray(eng.discoverWith(peerId))))
        }
    }

    /**
     * Return the once-only credential seed, then clear it from memory.
     *
     * Only ever populated in DEBUG builds (set by [MainActivity] from the
     * launch-intent extra `minutist_seed_credential`). The webview calls this
     * once on startup; if a non-null value is returned it writes it into
     * Keystore-encrypted storage via `SecureStorage.set` so the existing
     * auto-register path picks it up without an interactive sign-in flow.
     *
     * The seed is cleared after the first read so it does not linger in memory.
     * A null / empty return means no seed was injected — normal sign-in applies.
     */
    @PluginMethod
    fun getSeedCredential(call: PluginCall) {
        // debugOverride is non-null only in unit tests (Robolectric may not build
        // with a debug variant config on its classpath).
        val isDebug = debugOverride ?: BuildConfig.DEBUG

        if (!isDebug) {
            call.resolve(JSObject().put("seed", null as Any?))
            return
        }
        val seed = pendingSeed
        pendingSeed = null  // consume once
        call.resolve(JSObject().put("seed", seed))
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
            } finally {
                releaseWifiLock()
            }
        }
    }

    // -------------------------------------------------------------------------
    // Wifi lock — keep the relay connection alive against wifi power-save
    // -------------------------------------------------------------------------

    /**
     * Hold the wifi radio at full power for the sync engine's lifetime so the
     * relay connection is not idle-dropped by wifi power-save (observed as an
     * `os error 103` "Software caused connection abort" seconds after homing).
     * Complements the QUIC keepalive on the connection itself: the keepalive keeps
     * the connection warm, this keeps the radio awake enough to carry it.
     *
     * [WifiManager.WIFI_MODE_FULL_HIGH_PERF] is deliberate over `FULL_LOW_LATENCY`:
     * the low-latency mode only engages while the app is foregrounded, but a
     * recording session runs screen-off in the background under
     * [RecordingForegroundService] (which holds the CPU awake) — the socket still
     * has to survive there, and high-perf is foreground-independent.
     *
     * This alone does NOT keep sync alive when the app is backgrounded and not
     * recording: with no foreground service the process is Doze-suspended and the
     * lock with it. Background-while-idle sync survival would need a dedicated
     * data-sync foreground service (a persistent notification) — a separate call.
     *
     * Not reference-counted, with a null guard, so a redundant call while the lock
     * is already held is a no-op. Takes an explicit [ctx] rather than reading the
     * plugin's bridge context so it is unit-testable without a live bridge.
     */
    @Suppress("DEPRECATION") // FULL_HIGH_PERF: see above — LOW_LATENCY is foreground-only.
    @VisibleForTesting
    internal fun acquireWifiLock(ctx: Context) {
        if (wifiLock != null) return
        val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        wifiLock = wm.createWifiLock(
            WifiManager.WIFI_MODE_FULL_HIGH_PERF,
            "ai.minutist.companion:SyncWifiLock",
        ).also {
            it.setReferenceCounted(false)
            it.acquire()
        }
    }

    /** Release the wifi lock if held. Idempotent. */
    @VisibleForTesting
    internal fun releaseWifiLock() {
        wifiLock?.let { if (it.isHeld) it.release() }
        wifiLock = null
    }

    /** Test-only: whether the wifi lock is currently held. */
    @VisibleForTesting
    internal fun isWifiLockHeld(): Boolean = wifiLock?.isHeld == true

    /** The host component of a relay URL, for DNS resolution. Null if unparseable. */
    @VisibleForTesting
    internal fun relayHost(relayUrl: String): String? =
        try {
            URI(relayUrl).host
        } catch (e: Exception) {
            null
        }

    /**
     * Resolve the relay hostname to IPs, handed to the sync engine which seeds a
     * static resolver from them (the hostname is preserved as TLS SNI, so cert
     * verification still holds). The engine then performs NO in-app DNS query for
     * the relay — sidestepping a DNS-intercepting VPN entirely.
     *
     * Resolution runs ON a specific non-VPN link ([Network.getAllByName], wifi
     * first), so the DNS query egresses that interface and reaches its real
     * resolver (e.g. the wifi router 192.168.0.1). A plain
     * [InetAddress.getAllByName] uses the app's DEFAULT network, which under a VPN
     * like Tailscale is the tunnel — whose MagicDNS does not answer raw in-app
     * resolution, so it returns nothing. Binding to the underlying link is the
     * standard way to resolve past a split-tunnel VPN. Falls back to the default
     * resolver (correct when no VPN is active); empty on total failure → the
     * engine uses its DoH default. Blocking; call only from the IO dispatcher.
     */
    @VisibleForTesting
    internal fun resolveRelayIps(ctx: Context, relayUrl: String): List<String> {
        val host = relayHost(relayUrl) ?: return emptyList()
        val cm = ctx.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE)
            as? ConnectivityManager
        for (net in cm?.let { orderedNonVpnNetworks(it) }.orEmpty()) {
            try {
                val ips = net.getAllByName(host).mapNotNull { it.hostAddress }
                if (ips.isNotEmpty()) {
                    Log.i("minutist.sync", "resolved relay $host -> $ips (non-VPN link)")
                    return ips
                }
            } catch (e: Exception) {
                Log.w("minutist.sync", "relay resolve on a link failed: ${e.message}")
            }
        }
        // Last resort: the default resolver (correct when nothing is intercepting).
        val ips = try {
            InetAddress.getAllByName(host).mapNotNull { it.hostAddress }
        } catch (e: Exception) {
            Log.w("minutist.sync", "relay resolve (default) failed: ${e.message}")
            emptyList()
        }
        Log.i("minutist.sync", "resolved relay $host -> $ips (default resolver)")
        return ips
    }

    /** Internet-capable non-VPN links, wifi first, for [Network.getAllByName]. */
    @Suppress("DEPRECATION") // allNetworks: portable link enumeration on minSdk 24.
    private fun orderedNonVpnNetworks(cm: ConnectivityManager): List<Network> {
        val wifi = mutableListOf<Network>()
        val other = mutableListOf<Network>()
        for (n in cm.allNetworks) {
            val caps = cm.getNetworkCapabilities(n) ?: continue
            if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) continue
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) continue
            if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) wifi += n else other += n
        }
        return wifi + other
    }

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
