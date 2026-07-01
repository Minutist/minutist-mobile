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

It also carries the native-sync toolchain: Android NDK r27, a pinned Rust
toolchain (1.91.0 — iroh's MSRV; the host default stable is too old), the
`aarch64-linux-android` target, and `cargo-ndk`. That lets the desktop `sync`
crate be cross-compiled to an aarch64 `.so` (via UniFFI) for gradle to bundle.
The shell build itself uses none of it; the toolchain is for the sync plugin.

Sanity-check the cross-compile toolchain:

```sh
docker run --rm minutist/android-build:local bash -lc '
  cd /tmp && cargo new --lib spike >/dev/null && cd spike
  printf "[lib]\ncrate-type=[\"cdylib\"]\n[dependencies]\niroh-blobs={version=\"=0.103.0\",features=[\"fs-store\"]}\niroh=\"=1.0.0\"\n" >> Cargo.toml
  cargo ndk -t arm64-v8a --platform 24 build && ls target/aarch64-linux-android/debug/*.so'
```
