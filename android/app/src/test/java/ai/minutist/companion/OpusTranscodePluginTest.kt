// SPDX-License-Identifier: AGPL-3.0-only
package ai.minutist.companion

import android.os.Build
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Unit tests for API-level guards and the AacToOpusTranscoder.isSupported flag.
 *
 * Full pipeline integration (MediaCodec / MediaExtractor / MediaMuxer) requires
 * real hardware codecs and is covered by the on-emulator e2e validation script
 * (e2e/validate-transcode-on-step.sh), not by these JVM unit tests.
 */
@RunWith(RobolectricTestRunner::class)
class OpusTranscodePluginTest {

    // -------------------------------------------------------------------------
    // isSupported gate
    // -------------------------------------------------------------------------

    @Test
    @Config(sdk = [Build.VERSION_CODES.Q]) // API 29 — minimum for Ogg-Opus muxing
    fun `isSupported returns true on API 29`() {
        assertTrue(
            "Ogg-Opus muxing must be flagged as supported on API 29",
            AacToOpusTranscoder.isSupported,
        )
    }

    @Test
    @Config(sdk = [Build.VERSION_CODES.UPSIDE_DOWN_CAKE]) // API 34
    fun `isSupported returns true on API 34`() {
        assertTrue(AacToOpusTranscoder.isSupported)
    }

    @Test
    @Config(sdk = [Build.VERSION_CODES.O]) // API 26 — below the threshold
    fun `isSupported returns false on API 26`() {
        assertFalse(
            "Ogg-Opus muxing must NOT be flagged as supported on API 26",
            AacToOpusTranscoder.isSupported,
        )
    }

    @Test
    @Config(sdk = [Build.VERSION_CODES.P]) // API 28 — one below the threshold
    fun `isSupported returns false on API 28`() {
        assertFalse(AacToOpusTranscoder.isSupported)
    }

    // -------------------------------------------------------------------------
    // LinearResampler contract (via the package-private class)
    // -------------------------------------------------------------------------

    @Test
    @Config(sdk = [Build.VERSION_CODES.Q])
    fun `resampler produces correct output length for 44100 to 16000 mono`() {
        // For a 44100 → 16000 ratio the output length ≈ input * 16000/44100.
        val inputLen = 4410 // 100 ms at 44100 Hz
        val expectedLen = (inputLen.toLong() * 16000 / 44100).toInt()

        val samples = ShortArray(inputLen) { (it % 1000).toShort() }
        val resampler = LinearResampler(44100, 16000, 1)
        val output = resampler.process(samples)

        // Allow ±1 sample for rounding.
        assertTrue(
            "Expected output length $expectedLen ±1, got ${output.size}",
            output.size in (expectedLen - 1)..(expectedLen + 1),
        )
    }

    @Test
    @Config(sdk = [Build.VERSION_CODES.Q])
    fun `resampler downmixes stereo to mono`() {
        // Two-channel input: left=1000, right=3000 — downmixed mono should be ~2000.
        val stereoSamples = ShortArray(2) { if (it % 2 == 0) 1000 else 3000 }
        val resampler = LinearResampler(16000, 16000, 2)
        val output = resampler.process(stereoSamples)

        // With a 16 kHz → 16 kHz identity resample the single output sample
        // should be the average of the two channels.
        assertTrue("Output must not be empty", output.isNotEmpty())
        val expected = ((1000 + 3000) / 2).toShort()
        assertEquals("Downmix of (1000+3000)/2 must be $expected", expected, output[0])
    }

    @Test
    @Config(sdk = [Build.VERSION_CODES.Q])
    fun `resampler handles empty input without throwing`() {
        val resampler = LinearResampler(44100, 16000, 1)
        val output = resampler.process(ShortArray(0))
        assertEquals(0, output.size)
    }
}
