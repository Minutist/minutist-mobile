// swift-tools-version: 5.9
import PackageDescription

// Capacitor discovers this package because its package.json carries a
// `capacitor` key, so `npx cap sync ios` adds it to the app's generated
// CapApp-SPM manifest alongside the first-party plugins. That is what makes the
// plugin both linked and REGISTERED: a hand-added SPM dependency links the code,
// but the bridge only registers plugins it discovers this way, so load() and the
// bridged methods are never called.
// The package and product names are not free choices: `cap sync` derives both
// from the npm scope and name (@minutist/capacitor-sync-ffi ->
// MinutistCapacitorSyncFfi) when it writes the app's manifest, and resolution
// fails if they do not match. Only the target name is ours.
let package = Package(
    name: "MinutistCapacitorSyncFfi",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "MinutistCapacitorSyncFfi", targets: ["SyncFfiPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        // Built by scripts/build-sync-ffi-ios.sh from the desktop repo's
        // crates/sync-ffi, and gitignored exactly like the Android .so — so a
        // fresh clone must run that script before the iOS app will build.
        .binaryTarget(name: "SyncFfiBinary", path: "SyncFfi.xcframework"),
        .target(
            name: "SyncFfiPlugin",
            dependencies: [
                "SyncFfiBinary",
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/SyncFfiPlugin",
            // A static library carries no link directives, so any framework its
            // Rust dependencies call has to be linked here. iroh's
            // local-address discovery reaches SystemConfiguration through the
            // netdev and system_configuration crates (SCNetworkReachability*,
            // SCNetworkProtocolGetConfiguration). Android never needed this: a
            // .so resolves its own dependencies at load time.
            linkerSettings: [
                .linkedFramework("SystemConfiguration")
            ]
        )
    ]
)
