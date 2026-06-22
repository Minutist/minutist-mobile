# Android build image

Headless debug-APK build image. Base: `ghcr.io/cirruslabs/android-sdk:35`
(Ubuntu 24.04, OpenJDK 21, SDK licences pre-accepted), plus Node 20 and pinned
SDK components.

```sh
docker build -t minutist/android-build:local .
```

Used by the local build/test/review loop and by `docs/BUILD.md`. CI uses the
SDK preinstalled on GitHub-hosted `ubuntu-latest` instead, so this image is for
host-local builds where no SDK is present.

When the native sync plugin lands (Rust `sync` crate cross-compiled to
`aarch64-linux-android` via UniFFI), switch the base to the cirruslabs `-ndk`
variant and add the Rust Android target — a pure-webview APK needs no NDK, a
JNI/native-lib one does.
