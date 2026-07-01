package ai.minutist.companion;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        // Register app-local plugins before the bridge initialises so they are
        // available to the webview on first load.
        registerPlugin(RecordingForegroundServicePlugin.class);
        registerPlugin(OpusTranscodePlugin.class);
        registerPlugin(SyncPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
