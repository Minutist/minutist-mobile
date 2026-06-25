// SPDX-License-Identifier: AGPL-3.0-only
package ai.minutist.companion

import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.Build
import androidx.annotation.RequiresApi
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Transcodes a captured AAC/M4A file to 16 kHz mono Ogg-Opus.
 *
 * The desktop audio pipeline expects "audio.opus" as 16 kHz mono Ogg-Opus.
 * Android's MediaCodec Opus encoder + MediaMuxer with OUTPUT_FORMAT_OGG
 * satisfies this contract without any Rust or sync-layer change.
 *
 * Ogg-Opus muxing requires API 29+ (Android 10).  The [isSupported] guard
 * must be checked before calling [transcode]; on pre-29 devices the caller
 * should pass the raw AAC URI to the sync layer and let the desktop transcode.
 *
 * Pipeline: MediaExtractor (AAC) → MediaCodec decoder (PCM) →
 *            resample/downmix to 16 kHz mono → MediaCodec Opus encoder →
 *            MediaMuxer (Ogg) → outputFile
 *
 * Threading: [transcode] is synchronous and CPU-bound.  Callers must run it
 * on a background thread (e.g. via a coroutine dispatcher or a thread pool).
 * It does NOT interact with the UI thread or any Android UI component.
 */
@RequiresApi(Build.VERSION_CODES.Q)
internal class AacToOpusTranscoder {

    /**
     * Transcode [inputFile] (AAC/M4A) to 16 kHz mono Ogg-Opus written at
     * [outputFile].  [outputFile] is created or overwritten.
     *
     * @throws IllegalArgumentException if no audio track is found in [inputFile].
     * @throws RuntimeException on MediaCodec or MediaMuxer failures.
     */
    fun transcode(inputFile: File, outputFile: File) {
        val extractor = MediaExtractor()
        extractor.setDataSource(inputFile.absolutePath)

        // Locate the first audio track in the container.
        val trackIndex = (0 until extractor.trackCount)
            .firstOrNull { i ->
                extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME)
                    ?.startsWith("audio/") == true
            }
            ?: throw IllegalArgumentException("No audio track found in ${inputFile.name}")

        extractor.selectTrack(trackIndex)
        val inputFormat = extractor.getTrackFormat(trackIndex)

        val inputSampleRate = inputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        val inputChannels = inputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT)

        // --- AAC decoder ---
        val decoder = MediaCodec.createDecoderByType(
            inputFormat.getString(MediaFormat.KEY_MIME)!!,
        )
        decoder.configure(inputFormat, null, null, 0)
        decoder.start()

        // --- Opus encoder ---
        val encoderFormat = MediaFormat.createAudioFormat(OPUS_MIME, TARGET_SAMPLE_RATE, 1)
        encoderFormat.setInteger(MediaFormat.KEY_BIT_RATE, OPUS_BIT_RATE)
        // Opus frame duration in µs: 20 ms = 20 000 µs.
        encoderFormat.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 65536)

        val encoder = MediaCodec.createEncoderByType(OPUS_MIME)
        encoder.configure(encoderFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        encoder.start()

        // --- Muxer ---
        outputFile.parentFile?.mkdirs()
        val muxer = MediaMuxer(outputFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_OGG)

        try {
            runPipeline(
                extractor, decoder, encoder, muxer,
                inputSampleRate, inputChannels,
            )
        } finally {
            // Release in reverse order.  Each release is wrapped independently so a
            // failure in one does not prevent the others from running.
            runCatching { encoder.stop(); encoder.release() }
            runCatching { decoder.stop(); decoder.release() }
            runCatching { extractor.release() }
            runCatching { muxer.release() }
        }
    }

    // -------------------------------------------------------------------------
    // Internal pipeline
    // -------------------------------------------------------------------------

    private fun runPipeline(
        extractor: MediaExtractor,
        decoder: MediaCodec,
        encoder: MediaCodec,
        muxer: MediaMuxer,
        inputSampleRate: Int,
        inputChannels: Int,
    ) {
        val bufferInfo = MediaCodec.BufferInfo()
        var decoderDone = false
        var encoderDone = false
        var muxerTrackIndex = -1
        var muxerStarted = false

        // A simple linear resampler accumulates fractional position across calls.
        val resampler = LinearResampler(inputSampleRate, TARGET_SAMPLE_RATE, inputChannels)

        while (!encoderDone) {
            // --- Feed extractor → decoder ---
            if (!decoderDone) {
                val inputBufIdx = decoder.dequeueInputBuffer(TIMEOUT_US)
                if (inputBufIdx >= 0) {
                    val inputBuf = decoder.getInputBuffer(inputBufIdx)!!
                    val sampleSize = extractor.readSampleData(inputBuf, 0)
                    if (sampleSize < 0) {
                        decoder.queueInputBuffer(
                            inputBufIdx, 0, 0, 0,
                            MediaCodec.BUFFER_FLAG_END_OF_STREAM,
                        )
                        decoderDone = true
                    } else {
                        decoder.queueInputBuffer(
                            inputBufIdx, 0, sampleSize,
                            extractor.sampleTime, 0,
                        )
                        extractor.advance()
                    }
                }
            }

            // --- Drain decoder → PCM → resample → encoder ---
            val decoderOutputIdx = decoder.dequeueOutputBuffer(bufferInfo, TIMEOUT_US)
            if (decoderOutputIdx >= 0) {
                val pcmBuf = decoder.getOutputBuffer(decoderOutputIdx)
                if (pcmBuf != null && bufferInfo.size > 0) {
                    // PCM is 16-bit signed little-endian.
                    val samples = ShortArray(bufferInfo.size / 2)
                    pcmBuf.order(ByteOrder.LITTLE_ENDIAN)
                    pcmBuf.position(bufferInfo.offset)
                    pcmBuf.asShortBuffer().get(samples)

                    val resampled = resampler.process(samples)
                    feedPcmToEncoder(encoder, resampled)
                }

                val eos = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
                decoder.releaseOutputBuffer(decoderOutputIdx, false)

                if (eos) {
                    signalEncoderEos(encoder)
                }
            }

            // --- Drain encoder → muxer ---
            val encoderOutputIdx = encoder.dequeueOutputBuffer(bufferInfo, TIMEOUT_US)
            when {
                encoderOutputIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    val format = encoder.outputFormat
                    muxerTrackIndex = muxer.addTrack(format)
                    muxer.start()
                    muxerStarted = true
                }
                encoderOutputIdx >= 0 -> {
                    val encodedBuf = encoder.getOutputBuffer(encoderOutputIdx)
                    if (encodedBuf != null && muxerStarted &&
                        (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 &&
                        bufferInfo.size > 0
                    ) {
                        encodedBuf.position(bufferInfo.offset)
                        encodedBuf.limit(bufferInfo.offset + bufferInfo.size)
                        muxer.writeSampleData(muxerTrackIndex, encodedBuf, bufferInfo)
                    }
                    val eos = (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
                    encoder.releaseOutputBuffer(encoderOutputIdx, false)
                    if (eos) encoderDone = true
                }
            }
        }
    }

    /**
     * Feed a block of 16-bit mono 16 kHz PCM samples to the encoder as one or
     * more encoder input buffers.
     */
    private fun feedPcmToEncoder(encoder: MediaCodec, samples: ShortArray) {
        var offset = 0
        while (offset < samples.size) {
            val inputBufIdx = encoder.dequeueInputBuffer(TIMEOUT_US)
            if (inputBufIdx < 0) continue

            val inputBuf = encoder.getInputBuffer(inputBufIdx)!!
            inputBuf.clear()
            val capacity = inputBuf.remaining() / 2 // capacity in samples
            val chunk = minOf(capacity, samples.size - offset)

            inputBuf.order(ByteOrder.LITTLE_ENDIAN)
            for (i in 0 until chunk) {
                inputBuf.putShort(samples[offset + i])
            }

            encoder.queueInputBuffer(inputBufIdx, 0, chunk * 2, 0, 0)
            offset += chunk
        }
    }

    private fun signalEncoderEos(encoder: MediaCodec) {
        // Retry until an input buffer is available — a single dequeue that returns
        // < 0 would leave the encoder without EOS and spin the drain loop forever.
        var inputBufIdx = encoder.dequeueInputBuffer(TIMEOUT_US)
        while (inputBufIdx < 0) {
            inputBufIdx = encoder.dequeueInputBuffer(TIMEOUT_US)
        }
        encoder.queueInputBuffer(
            inputBufIdx, 0, 0, 0,
            MediaCodec.BUFFER_FLAG_END_OF_STREAM,
        )
    }

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    companion object {
        const val TARGET_SAMPLE_RATE = 16_000
        private const val OPUS_MIME = "audio/opus"
        private const val OPUS_BIT_RATE = 32_000
        private const val TIMEOUT_US = 10_000L

        /** True when the OS supports Ogg-Opus muxing (API 29+). */
        val isSupported: Boolean
            get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
    }
}

// =============================================================================
// LinearResampler — single-pass sample-rate converter + stereo→mono downmix
// =============================================================================

/**
 * Resamples and optionally downmixes [inputChannels]-channel 16-bit PCM from
 * [inputRate] Hz to [outputRate] Hz mono using linear interpolation.
 *
 * For the common case (44.1 kHz stereo → 16 kHz mono) this is accurate enough
 * for speech-quality ASR input without pulling in an external DSP library.
 *
 * Internal visibility so JVM unit tests in the same package can access it
 * without reflection.
 */
internal class LinearResampler(
    private val inputRate: Int,
    private val outputRate: Int,
    private val inputChannels: Int,
) {
    // Fractional input position carried across consecutive [process] calls so
    // that sample-rate ratios that are not integers produce clean output at
    // block boundaries.
    private var fractionalPos: Double = 0.0

    // Last input sample from the previous block (for interpolation across blocks).
    private var prevSample: Float = 0f

    fun process(inputSamples: ShortArray): ShortArray {
        if (inputSamples.isEmpty()) return ShortArray(0)

        // Build a mono float array (average channels).
        val monoInput = FloatArray(inputSamples.size / inputChannels)
        for (i in monoInput.indices) {
            var sum = 0f
            for (ch in 0 until inputChannels) {
                sum += inputSamples[i * inputChannels + ch].toFloat()
            }
            monoInput[i] = sum / inputChannels
        }

        // Compute output length.
        val ratio = inputRate.toDouble() / outputRate
        val outputLen = ((monoInput.size - fractionalPos) / ratio).toInt()
        if (outputLen <= 0) {
            // Store tail sample for next block.
            if (monoInput.isNotEmpty()) prevSample = monoInput.last()
            return ShortArray(0)
        }

        val output = ShortArray(outputLen)
        for (outIdx in 0 until outputLen) {
            val inPos = fractionalPos + outIdx * ratio
            val inIdx = inPos.toInt()
            val frac = (inPos - inIdx).toFloat()

            // inIdx may be -1 only when fractionalPos < 0 (never in our usage),
            // or it may equal monoInput.size when we overshoot at the tail.
            // prevSample provides the last sample of the prior block for cross-block
            // interpolation; it is never used for in-block samples.
            val s0 = if (inIdx < 0) prevSample
                     else if (inIdx < monoInput.size) monoInput[inIdx]
                     else monoInput.last()
            val s1 = if (inIdx + 1 < monoInput.size) monoInput[inIdx + 1]
                     else if (inIdx < monoInput.size) monoInput[inIdx]
                     else monoInput.last()

            val interpolated = s0 + (s1 - s0) * frac
            output[outIdx] = interpolated.toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
        }

        // Advance fractional position for the next block.
        fractionalPos = fractionalPos + outputLen * ratio - monoInput.size
        if (monoInput.isNotEmpty()) prevSample = monoInput.last()

        return output
    }
}
