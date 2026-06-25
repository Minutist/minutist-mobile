// SPDX-License-Identifier: AGPL-3.0-only
package ai.minutist.companion

import android.net.Uri
import android.os.Build
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

/**
 * Capacitor plugin that transcodes a captured AAC file to 16 kHz mono Ogg-Opus
 * and writes the result to a deterministic per-capture directory inside the
 * app's private files directory.
 *
 * Exposed method: [transcode]
 *
 * Call pattern (TypeScript):
 * ```ts
 * const result = await OpusTranscodePlugin.transcode({ captureId, aacUri });
 * // result.opusPath: absolute path to audio.opus (API 29+)
 * // result.opusPath: undefined  (pre-29: caller uses aacUri directly)
 * // result.supported: boolean
 * ```
 *
 * API-level policy:
 * - API 29+ (Android 10): transcode runs natively; result carries opusPath.
 * - API 24–28: transcode is not performed; opusPath is absent; the desktop
 *   is responsible for transcoding the AAC it receives via sync.
 *
 * The output file is:
 *   `<filesDir>/captures/<captureId>/audio.opus`
 *
 * This path is inside the app's private files directory and is accessible
 * in debug builds via `adb exec-out run-as ai.minutist.companion cat <path>`.
 *
 * The matching TypeScript binding is in src/capture/opusTranscode.ts.
 */
@CapacitorPlugin(name = "OpusTranscode")
class OpusTranscodePlugin : Plugin() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * Transcode [aacUri] (a content:// or file:// URI of the captured AAC) to
     * 16 kHz mono Ogg-Opus.
     *
     * Params (JSObject):
     *   captureId: String  — unique capture identifier; used for the output dir name.
     *   aacUri:    String  — platform URI of the source AAC file.
     *
     * Result:
     *   supported: Boolean — true when the device runs API 29+.
     *   opusPath:  String? — absolute path to the written audio.opus (API 29+ only).
     */
    @PluginMethod
    fun transcode(call: PluginCall) {
        val captureId = call.getString("captureId")
            ?: return call.reject("captureId is required")
        val aacUri = call.getString("aacUri")
            ?: return call.reject("aacUri is required")

        val supported = AacToOpusTranscoder.isSupported
        if (!supported) {
            // Pre-29: return immediately; caller uses the AAC URI directly.
            call.resolve(JSObject().apply {
                put("supported", false)
            })
            return
        }

        scope.launch {
            var tempInput: File? = null
            try {
                val uri = Uri.parse(aacUri)
                val inputFile = when (uri.scheme) {
                    "file" -> uri.path?.let { File(it) }
                    "content" -> copyContentUriToTemp(uri)?.also { tempInput = it }
                    else -> null
                } ?: return@launch call.reject("Cannot resolve aacUri: $aacUri")

                val outputDir = File(context.filesDir, "captures/$captureId")
                outputDir.mkdirs()
                val outputFile = File(outputDir, "audio.opus")

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    AacToOpusTranscoder().transcode(inputFile, outputFile)
                }

                call.resolve(JSObject().apply {
                    put("supported", true)
                    put("opusPath", outputFile.absolutePath)
                })
            } catch (e: Exception) {
                call.reject("Transcode failed: ${e.message}", e)
            } finally {
                // A content:// input was copied to a cache temp — delete it.
                tempInput?.delete()
            }
        }
    }

    // -------------------------------------------------------------------------
    // URI resolution
    // -------------------------------------------------------------------------

    /**
     * Copy a content:// URI to a temp file in the app cache so MediaExtractor
     * can open it by path. The caller deletes it after transcode.
     */
    private fun copyContentUriToTemp(uri: Uri): File? {
        return try {
            val tmpFile = File(context.cacheDir, "transcode_input_${System.currentTimeMillis()}.m4a")
            context.contentResolver.openInputStream(uri)?.use { input ->
                tmpFile.outputStream().use { output -> input.copyTo(output) }
            }
            tmpFile
        } catch (_: Exception) {
            null
        }
    }
}
