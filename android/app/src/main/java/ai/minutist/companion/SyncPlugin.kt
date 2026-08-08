// SPDX-License-Identifier: AGPL-3.0-only
package ai.minutist.companion

import android.content.Context
import android.net.ConnectivityManager
import android.net.DnsResolver
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
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
     * A wifi lock held across a sync window (see [acquireWifiLock]), scoped by
     * [beginSyncHold]/[endSyncHold] rather than the engine lifetime. Null when no
     * sync is in flight.
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
                call.reject("sync start failed: ${e.message}", e)
            }
        }
    }

    /**
     * Acquire the wifi hold for a sync window. Called by the JS sync layer around a
     * push (syncMeeting) — NOT for the engine's whole lifetime — so the radio is
     * kept out of power-save only while data is actually moving (avoids an
     * always-on battery cost). Idempotent; see [acquireWifiLock].
     */
    @PluginMethod
    fun beginSyncHold(call: PluginCall) {
        acquireWifiLock(context)
        call.resolve()
    }

    /** Release the sync-window wifi hold. Idempotent. */
    @PluginMethod
    fun endSyncHold(call: PluginCall) {
        releaseWifiLock()
        call.resolve()
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
     * Params: endpointId (required), relayUrl (required), directAddrs (optional
     * "ip:port" strings — the peer's direct addresses from the account directory,
     * so a same-tailnet/LAN peer is dialled directly instead of via the relay).
     * Unparseable entries are skipped Rust-side; an empty list falls back to relay.
     */
    @PluginMethod
    fun addAccountPeer(call: PluginCall) {
        val endpointId = call.getString("endpointId") ?: return call.reject("endpointId is required")
        val relayUrl = call.getString("relayUrl") ?: return call.reject("relayUrl is required")
        val directAddrs = call.getArray("directAddrs")?.toList<String>() ?: emptyList()
        withEngine(call) { eng ->
            eng.addAccountPeer(endpointId, relayUrl, directAddrs)
            call.resolve()
        }
    }

    /**
     * This device's own filtered direct addresses ("ip:port" strings) so the TS
     * account-client can publish them to the directory alongside the endpoint id.
     * Same filter as the hub/desktop register-self. Corresponds to
     * [FfiSyncEngine.ownDirectAddrs]. Returns: { directAddrs: string[] }.
     */
    @PluginMethod
    fun ownDirectAddrs(call: PluginCall) = withEngine(call) { eng ->
        call.resolve(JSObject().put("directAddrs", JSArray(eng.ownDirectAddrs())))
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
                // The sync-window wifi hold is scoped by beginSyncHold/endSyncHold,
                // not the engine lifetime, but release defensively in case a hold
                // was left open when the engine was torn down mid-sync.
                releaseWifiLock()
            }
        }
    }

    // -------------------------------------------------------------------------
    // Wifi lock — keep the relay connection alive against wifi power-save
    // -------------------------------------------------------------------------

    /**
     * Hold the wifi radio at full power across a sync window (scoped by
     * [beginSyncHold]/[endSyncHold], not the engine lifetime) so the relay
     * connection is not idle-dropped by wifi power-save mid-transfer (observed as
     * an `os error 103` "Software caused connection abort"). Complements iroh's
     * built-in QUIC keepalive: the keepalive keeps the connection warm, this keeps
     * the radio awake enough to carry it.
     *
     * [WifiManager.WIFI_MODE_FULL_HIGH_PERF] is deliberate over `FULL_LOW_LATENCY`:
     * low-latency only engages while the app is foregrounded, but a sync can drain
     * screen-off/backgrounded under [SyncForegroundService] (which holds the CPU
     * awake) — the socket still has to survive there, and high-perf is
     * foreground-independent.
     *
     * Scoping the hold to the window (rather than the engine lifetime) avoids an
     * always-on radio battery cost; between syncs the idle relay connection may
     * drop and iroh re-homes on the next push. Keeping the process alive to drain a
     * backgrounded sync is [SyncForegroundService]'s job, not this lock's.
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
     * Resolution runs ON each candidate link via [Network.getAllByName] (wifi →
     * cellular → VPN, then the default resolver), which uses THAT network's own
     * system resolver, and returns the first non-empty result. Binding to a link
     * this way is the standard way to resolve past a split-tunnel VPN (the query
     * egresses that interface to its real resolver, e.g. the wifi router
     * 192.168.0.1) — and, unlike a raw-UDP query to a VPN's MagicDNS, it also
     * resolves via the VPN link itself, so the VPN entry is a valid last-resort
     * fallback when a non-VPN link's resolver is unavailable (e.g. a
     * captive-portal-flagged wifi). Retries a few rounds so a not-yet-ready
     * network stack at cold start doesn't strand the engine; empty only after all
     * rounds fail → the engine uses its DoH default. Blocking; IO dispatcher only.
     */
    @VisibleForTesting
    internal fun resolveRelayIps(ctx: Context, relayUrl: String): List<String> {
        val host = relayHost(relayUrl) ?: return emptyList()
        val cm = ctx.applicationContext.getSystemService(Context.CONNECTIVITY_SERVICE)
            as? ConnectivityManager
        // Retry across a few rounds: at cold start the network stack may not be
        // enumerable yet, and any single link's resolver can transiently fail.
        val rounds = 4
        repeat(rounds) { attempt ->
            // Primary: the platform system resolver (VPN-aware — resolves under
            // Tailscale, where the app's Java getAllByName APIs return nothing).
            resolveViaSystemDnsResolver(host).let { sys ->
                if (sys.isNotEmpty()) {
                    Log.i("minutist.sync", "resolved relay $host -> $sys (system DnsResolver)")
                    return sys
                }
            }
            for (net in cm?.let { orderedResolveNetworks(it) }.orEmpty()) {
                val via = cm?.getNetworkCapabilities(net)?.let { describeTransports(it) } ?: "?"
                try {
                    val ips = net.getAllByName(host).mapNotNull { it.hostAddress }
                    if (ips.isNotEmpty()) {
                        Log.i("minutist.sync", "resolved relay $host -> $ips (via $via)")
                        return ips
                    }
                    Log.i("minutist.sync", "relay resolve via $via: empty")
                } catch (e: Exception) {
                    Log.w("minutist.sync", "relay resolve via $via failed: ${e.message}")
                }
            }
            // Per-round last resort: the app's default network resolver.
            try {
                val ips = InetAddress.getAllByName(host).mapNotNull { it.hostAddress }
                if (ips.isNotEmpty()) {
                    Log.i("minutist.sync", "resolved relay $host -> $ips (default resolver)")
                    return ips
                }
            } catch (e: Exception) {
                Log.w("minutist.sync", "relay resolve (default) failed: ${e.message}")
            }
            if (attempt < rounds - 1) Thread.sleep(600L)
        }
        Log.w("minutist.sync", "relay resolve $host -> [] after $rounds rounds; engine uses DoH fallback")
        return emptyList()
    }

    /**
     * Resolve [host] via the platform system resolver ([DnsResolver], API 29+),
     * bridging its async callback to a blocking result (safe on the IO dispatcher).
     * This is the VPN-aware path netd itself uses, so it resolves under a
     * DNS-capturing VPN (Tailscale) where the app's Java getAllByName APIs return
     * nothing. Network `null` = the app's default network; the system resolver
     * handles the VPN routing. Empty on pre-29, error, or timeout.
     */
    private fun resolveViaSystemDnsResolver(host: String): List<String> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return emptyList()
        val latch = java.util.concurrent.CountDownLatch(1)
        val out = java.util.concurrent.atomic.AtomicReference<List<String>>(emptyList())
        val exec = java.util.concurrent.Executors.newSingleThreadExecutor()
        try {
            DnsResolver.getInstance().query(
                null,
                host,
                DnsResolver.FLAG_EMPTY,
                exec,
                null,
                object : DnsResolver.Callback<List<java.net.InetAddress>> {
                    override fun onAnswer(answer: List<java.net.InetAddress>, rcode: Int) {
                        out.set(answer.mapNotNull { it.hostAddress })
                        latch.countDown()
                    }

                    override fun onError(error: DnsResolver.DnsException) {
                        Log.w("minutist.sync", "system DnsResolver error for $host: ${error.message}")
                        latch.countDown()
                    }
                },
            )
            latch.await(5, java.util.concurrent.TimeUnit.SECONDS)
        } catch (e: Exception) {
            Log.w("minutist.sync", "system DnsResolver query failed for $host: ${e.message}")
        } finally {
            exec.shutdownNow()
        }
        return out.get()
    }

    /**
     * Internet-capable links to try for relay resolution, ordered by how directly
     * they resolve: wifi, then other non-VPN (cellular), then the VPN LAST. Every
     * entry resolves via [Network.getAllByName], which uses THAT network's own
     * system resolver — so the VPN entry works too (Tailscale's resolver forwards
     * upstream), serving as a fallback when a non-VPN link's resolver is
     * unavailable (e.g. a captive-portal-flagged wifi). Only the raw-UDP path a
     * VPN's MagicDNS refuses is avoided; getAllByName is not that path.
     */
    @Suppress("DEPRECATION") // allNetworks: portable link enumeration on minSdk 24.
    private fun orderedResolveNetworks(cm: ConnectivityManager): List<Network> {
        val wifi = mutableListOf<Network>()
        val other = mutableListOf<Network>()
        val vpn = mutableListOf<Network>()
        for (n in cm.allNetworks) {
            val caps = cm.getNetworkCapabilities(n) ?: continue
            if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) continue
            when {
                caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) -> vpn += n
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> wifi += n
                else -> other += n
            }
        }
        return wifi + other + vpn
    }

    /** Compact transport label for a network, for resolution logging. */
    private fun describeTransports(caps: NetworkCapabilities): String = buildString {
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) append("wifi ")
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) append("cell ")
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) append("vpn ")
    }.trim().ifEmpty { "other" }

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
