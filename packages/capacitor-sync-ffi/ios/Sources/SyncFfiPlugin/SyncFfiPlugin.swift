import Capacitor
import Foundation
import os

/// Capacitor bridge to the Rust sync engine, the iOS counterpart of
/// `SyncPlugin.kt`. `src/sync/plugin.ts` is the contract both sides implement.
///
/// `CAPBridgedPlugin` conformance is what makes the bridge register this plugin:
/// subclassing `CAPPlugin` alone links the code but leaves it unregistered, so
/// neither `load()` nor any bridged method is ever called.
///
/// Only the engine-probe surface exists so far. The remaining bridge methods
/// land with the port of the Kotlin plugin; `jsName` is deliberately NOT yet
/// `SyncFfi`, so the TypeScript side keeps using the mock client rather than
/// binding to a half-implemented native plugin.
@objc(SyncFfiPlugin)
public class SyncFfiPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SyncFfiPlugin"
    public let jsName = "SyncFfiProbe"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "probe", returnType: CAPPluginReturnPromise)
    ]

    private static let log = Logger(subsystem: "ai.minutist.companion", category: "syncffi")

    /// Engine handle. Guarded by `queue` rather than made atomic: every FFI call
    /// is a blocking `block_on` over the Rust runtime, so they must be
    /// serialised off the main thread anyway — the same constraint the Kotlin
    /// plugin meets with a single-threaded IO dispatcher.
    private var engine: FfiSyncEngine?
    private let queue = DispatchQueue(label: "ai.minutist.syncffi", qos: .userInitiated)

    override public func load() {
        Self.log.notice("SYNCFFI plugin registered")
        queue.async { [weak self] in self?.probeEngine() }
    }

    /// Bridged form of the same probe, so it can be driven from the web layer
    /// instead of only at load.
    @objc func probe(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            guard let self else { return }
            let result = self.probeEngine()
            call.resolve(result)
        }
    }

    /// Brings the engine up and reports what it managed. Results are logged and
    /// returned rather than asserted: this runs at launch, and a failure here is
    /// a finding about iOS, not a reason to take the app down.
    @discardableResult
    private func probeEngine() -> [String: Any] {
        var out: [String: Any] = [:]

        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let meetingsRoot = docs.appendingPathComponent("meetings", isDirectory: true)
        let appDataDir = docs.appendingPathComponent("sync-data", isDirectory: true)
        for dir in [meetingsRoot, appDataDir] {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }

        // The load-bearing step: builds a multi-thread tokio runtime, loads or
        // generates the ed25519 device key, and binds an iroh endpoint.
        if engine == nil {
            do {
                engine = try FfiSyncEngine.start(
                    relayUrl: "https://sync.minutist.ai",
                    relayAuthToken: nil,
                    meetingsRoot: meetingsRoot.path,
                    appDataDir: appDataDir.path,
                    relayIps: []
                )
                Self.log.notice("SYNCFFI engine started")
                out["started"] = true
            } catch {
                let message = String(describing: error)
                Self.log.error("SYNCFFI engine start failed: \(message, privacy: .public)")
                out["started"] = false
                out["error"] = message
                return out
            }
        } else {
            out["started"] = true
        }

        guard let engine else { return out }

        // A well-formed endpoint id proves key derivation and endpoint
        // construction both succeeded.
        do {
            let id = try engine.endpointId()
            Self.log.notice("SYNCFFI endpointId=\(id, privacy: .public)")
            out["endpointId"] = id
        } catch {
            Self.log.error("SYNCFFI endpointId failed: \(String(describing: error), privacy: .public)")
        }

        // Direct addresses show whether the endpoint discovered any local
        // addresses under iOS's network stack.
        do {
            let addrs = try engine.ownDirectAddrs()
            Self.log.notice("SYNCFFI directAddrs=\(addrs.count) \(addrs.joined(separator: ","), privacy: .public)")
            out["directAddrs"] = addrs
        } catch {
            Self.log.error("SYNCFFI ownDirectAddrs failed: \(String(describing: error), privacy: .public)")
        }

        // Reading the meeting list exercises the data layer against iOS's
        // sandboxed filesystem, whose shape differs from Android's.
        do {
            let meetings = try engine.listMeetings()
            Self.log.notice("SYNCFFI listMeetings=\(meetings.count)")
            out["meetings"] = meetings.count
        } catch {
            Self.log.error("SYNCFFI listMeetings failed: \(String(describing: error), privacy: .public)")
        }

        return out
    }
}
