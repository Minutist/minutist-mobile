/**
 * Thin TypeScript binding for the native OpusTranscodePlugin.
 *
 * On Android API 29+ the plugin transcodes the captured AAC to 16 kHz mono
 * Ogg-Opus and returns an absolute file path.  On older devices (API 24–28)
 * [transcode] resolves with `{ supported: false }` and `opusPath` is absent;
 * the caller should pass the original AAC URI to the sync layer so the desktop
 * can transcode it on adoption.
 *
 * On non-Android platforms (web, tests) the registered web fallback resolves
 * immediately with `{ supported: false }` so the module is safe to import
 * everywhere.
 *
 * Usage:
 * ```ts
 * import { transcodeAacToOpus } from './opusTranscode';
 * const result = await transcodeAacToOpus(captureId, aacUri);
 * const audioUri = result.opusPath ?? aacUri;
 * ```
 */

import { registerPlugin } from '@capacitor/core';

// ---------------------------------------------------------------------------
// Native plugin surface
// ---------------------------------------------------------------------------

interface OpusTranscodePlugin {
  transcode(opts: { captureId: string; aacUri: string }): Promise<{
    supported: boolean;
    opusPath?: string;
  }>;
}

const NativeOpusTranscode = registerPlugin<OpusTranscodePlugin>('OpusTranscode', {
  // Web / test fallback: no-op, transcode not supported off-device.
  web: {
    transcode: () => Promise.resolve({ supported: false }),
  },
});

// ---------------------------------------------------------------------------
// Public helper
// ---------------------------------------------------------------------------

/**
 * Transcode [aacUri] to 16 kHz mono Ogg-Opus using the native plugin.
 *
 * Returns the absolute path to the produced `audio.opus` when the device
 * supports on-device transcoding (API 29+), or `undefined` otherwise.
 * The caller should fall back to [aacUri] when `opusPath` is absent.
 *
 * Rejects if the native plugin reports a transcoding error.
 */
export async function transcodeAacToOpus(
  captureId: string,
  aacUri: string,
): Promise<{ opusPath?: string; supported: boolean }> {
  return NativeOpusTranscode.transcode({ captureId, aacUri });
}
