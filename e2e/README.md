# E2E lane — Maestro flows on the step KVM emulator

## What this is

`e2e/flows/` contains Maestro YAML flows that run against the debug APK in a
headless KVM Android Virtual Device on the `step` host (WSL2 / Win11).  The
app UI lives inside a Capacitor webview; Maestro matches visible text via
UIAutomator, which sees the rendered webview content.

## Prerequisites

- SSH key-auth to `step` is configured (passwordless).
- `rsync` is available on the calling machine.
- The `step` host has the provisioned AVD lane:
  `~/minutist-emulator/run-emulator-tests.sh` — see the emulator setup docs.
- `docker` is available on the calling machine if you need to build the APK
  locally (it is built automatically if the default path is absent).

## Running the full suite from Telie (or any machine with SSH access to step)

```sh
cd /path/to/minutist-mobile
bash e2e/run-on-step.sh
```

The runner:

1. Checks for the debug APK at
   `android/app/build/outputs/apk/debug/app-debug.apk`.  If absent it runs
   the docker build incantation from `docs/BUILD.md` to produce it.
2. `scp`s the APK to `step:~/minutist-app-debug.apk`.
3. `rsync`s `e2e/flows/` to `step:~/minutist-emulator/flows-repo/` (clearing
   it first so deleted flows do not persist).
4. `ssh step ~/minutist-emulator/run-emulator-tests.sh ~/minutist-app-debug.apk
   ~/minutist-emulator/flows-repo` and propagates Maestro's exit code.

## Environment variables

| Variable    | Default                                                              | Purpose                           |
|-------------|----------------------------------------------------------------------|-----------------------------------|
| `STEP_HOST` | `step`                                                               | SSH host alias for the emulator   |
| `APK`       | `android/app/build/outputs/apk/debug/app-debug.apk` (repo-relative) | Path to the APK to install        |

## Flows

| File                  | What it covers                                                    |
|-----------------------|-------------------------------------------------------------------|
| `smoke.yaml`          | App launches; wordmark "Minutist" is visible                      |
| `navigation.yaml`     | Capture → Meetings (empty state) → Capture tab-bar round-trip    |
| `notes.yaml`          | Quick-notes field: tap, type, assert visible text                 |
| `record.yaml`         | Start recording → assert Recording state → stop → Meetings badge  |
| `synced-viewer.yaml`  | Record → stop → Sync now → assert synced → open detail → summary |

## Constraint notes

- Only one emulator can run at a time on `step` — never invoke
  `run-on-step.sh` concurrently from multiple terminals.
- The emulator mic is virtual (silent).  `record.yaml` asserts UI state
  transitions, not audio content.  If the recorder plugin cannot start on the
  emulator it will surface as a test failure on the "Recording" assertion —
  treat that as a real finding, not a flake to silence.
- Flows use `clearState: true` on `launchApp` so each flow starts from a
  clean app state without residual data from previous runs.
