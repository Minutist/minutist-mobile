package ai.minutist.companion;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        // Register the app-local foreground-service plugin before the bridge
        // initialises so it is available to the webview on first load.
        registerPlugin(RecordingForegroundServicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
