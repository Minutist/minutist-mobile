package ai.minutist.companion;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        // Register app-local plugins before the bridge initialises so they are
        // available to the webview on first load.
        registerPlugin(RecordingForegroundServicePlugin.class);
        registerPlugin(SyncForegroundServicePlugin.class);
        registerPlugin(OpusTranscodePlugin.class);
        registerPlugin(SyncPlugin.class);
        super.onCreate(savedInstanceState);

        // DEBUG-only: seed a pre-minted credential so device-code sign-in is
        // skipped in automated e2e runs. The value is injected via the launch
        // intent extra `minutist_seed_credential` (e.g. `adb shell am start -n
        // ai.minutist.companion/.MainActivity -e minutist_seed_credential mdc_…`).
        if (BuildConfig.DEBUG) {
            String seed = getIntent().getStringExtra("minutist_seed_credential");
            if (seed != null && !seed.isEmpty()) {
                SyncPlugin plugin = (SyncPlugin) getBridge().getPlugin("SyncFfi").getInstance();
                if (plugin != null) {
                    plugin.setPendingSeed(seed);
                }
            }
        }
    }
}
