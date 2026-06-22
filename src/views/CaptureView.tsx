/**
 * CaptureView — record control, elapsed timer, VU meter, and quick-notes.
 *
 * Consumes the recorder facade (src/capture/recorder.ts) and the sync client
 * (via useSync).  On stop it persists the recording as a captured-unprocessed
 * meeting via SyncClient.saveCaptured so it appears in the Meetings list.
 *
 * Design constraints:
 * - All colours / fonts / radii reference theme.css variables only.
 * - The quick-notes field is a plain <textarea>, NOT Tiptap.
 * - No ML, no transcription, no Opus code anywhere in this file.
 * - Plugin calls are guarded: if the recorder facade throws (web / test env
 *   without a real plugin) the view degrades gracefully.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import * as Recorder from '../capture/recorder';
import type { MicPermission, RecorderStatus } from '../capture/recorder';
import { platformForegroundServiceController } from '../capture/foregroundService';
import { useSync } from '../sync/useSync';
import './CaptureView.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format elapsed seconds as mm:ss. */
function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Build a default meeting title from the current local time. */
function defaultTitle(): string {
  const now = new Date();
  return now.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// VU bar — lightweight amplitude visualiser
// ---------------------------------------------------------------------------

interface VuBarProps {
  /** Normalised amplitude in [0, 1]. */
  amplitude: number;
  active: boolean;
}

function VuBar({ amplitude, active }: VuBarProps) {
  return (
    <div
      className="capture-vu"
      aria-hidden="true"
      data-testid="vu-bar"
    >
      <div
        className={`capture-vu__fill${active ? ' capture-vu__fill--active' : ''}`}
        style={{ width: `${Math.round(amplitude * 100)}%` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// RecordButton — primary control rendered in three states
// ---------------------------------------------------------------------------

interface RecordButtonProps {
  status: RecorderStatus;
  onRecord: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  disabled: boolean;
}

function RecordButton({
  status,
  onRecord,
  onPause,
  onResume,
  onStop,
  disabled,
}: RecordButtonProps) {
  if (status === 'inactive') {
    return (
      <button
        className="capture-record-btn capture-record-btn--idle"
        onClick={onRecord}
        disabled={disabled}
        aria-label="Start recording"
        data-testid="record-button"
      >
        <span className="capture-record-btn__dot" aria-hidden="true" />
        Record
      </button>
    );
  }

  return (
    <div className="capture-record-controls" role="group" aria-label="Recording controls">
      {status === 'recording' ? (
        <button
          className="capture-record-btn capture-record-btn--pause"
          onClick={onPause}
          disabled={disabled}
          aria-label="Pause recording"
          data-testid="pause-button"
        >
          Pause
        </button>
      ) : (
        <button
          className="capture-record-btn capture-record-btn--resume"
          onClick={onResume}
          disabled={disabled}
          aria-label="Resume recording"
          data-testid="resume-button"
        >
          Resume
        </button>
      )}
      <button
        className="capture-record-btn capture-record-btn--stop"
        onClick={onStop}
        disabled={disabled}
        aria-label="Stop recording"
        data-testid="stop-button"
      >
        Stop
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CaptureView (root export)
// ---------------------------------------------------------------------------

export function CaptureView() {
  const sync = useSync();

  // Permission state — checked on mount; prompts on first record attempt.
  const [permission, setPermission] = useState<MicPermission>('prompt');

  // Recorder lifecycle state.
  const [recorderStatus, setRecorderStatus] = useState<RecorderStatus>('inactive');

  // Elapsed time driven by wall-clock intervals so it survives re-renders.
  const [elapsedSec, setElapsedSec] = useState(0);
  // Wall-clock ms when the most recent start/resume happened.
  const startWallRef = useRef<number | null>(null);
  // Accumulated seconds from completed recording spans (before the latest resume).
  const accumulatedSecRef = useRef(0);
  // Unix epoch ms when the entire recording session began.
  const sessionStartRef = useRef<number | null>(null);

  // VU amplitude in [0, 1].
  const [amplitude, setAmplitude] = useState(0);

  // Quick-notes textarea content.
  const [notes, setNotes] = useState('');

  // Transient UI state.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Check permission on mount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    Recorder.checkPermission()
      .then(setPermission)
      .catch(() => {
        // Plugin unavailable (web / test without real bridge) — treat as prompt.
        setPermission('prompt');
      });
  }, []);

  // ---------------------------------------------------------------------------
  // Elapsed timer
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (recorderStatus !== 'recording') return;

    const id = setInterval(() => {
      if (startWallRef.current === null) return;
      const spanSec = Math.floor((Date.now() - startWallRef.current) / 1000);
      setElapsedSec(accumulatedSecRef.current + spanSec);
    }, 500);

    return () => clearInterval(id);
  }, [recorderStatus]);

  // ---------------------------------------------------------------------------
  // Amplitude polling (~80 ms) — only while actively recording
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (recorderStatus !== 'recording') {
      setAmplitude(0);
      return;
    }

    const id = setInterval(async () => {
      try {
        const v = await Recorder.getAmplitude();
        setAmplitude(v);
      } catch {
        // Plugin unavailable; ignore.
      }
    }, 80);

    return () => clearInterval(id);
  }, [recorderStatus]);

  // ---------------------------------------------------------------------------
  // Record / pause / resume / stop handlers
  // ---------------------------------------------------------------------------

  const handleRecord = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      let perm = permission;
      if (perm !== 'granted') {
        perm = await Recorder.requestPermission();
        setPermission(perm);
      }
      if (perm !== 'granted') {
        setPermission('denied');
        setBusy(false);
        return;
      }
      const now = Date.now();
      sessionStartRef.current = now;
      startWallRef.current = now;
      accumulatedSecRef.current = 0;
      setElapsedSec(0);
      await Recorder.start(undefined, platformForegroundServiceController);
      setRecorderStatus('recording');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start recording');
    } finally {
      setBusy(false);
    }
  }, [permission]);

  const handlePause = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await Recorder.pause();
      // Snapshot accumulated time before the pause.
      if (startWallRef.current !== null) {
        accumulatedSecRef.current += Math.floor(
          (Date.now() - startWallRef.current) / 1000,
        );
        startWallRef.current = null;
      }
      setRecorderStatus('paused');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not pause');
    } finally {
      setBusy(false);
    }
  }, []);

  const handleResume = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await Recorder.resume();
      startWallRef.current = Date.now();
      setRecorderStatus('recording');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resume');
    } finally {
      setBusy(false);
    }
  }, []);

  const handleStop = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await Recorder.stop(platformForegroundServiceController);
      setRecorderStatus('inactive');
      setElapsedSec(0);
      accumulatedSecRef.current = 0;
      startWallRef.current = null;

      const startedAt = sessionStartRef.current ?? Date.now() - result.durationMs;
      sessionStartRef.current = null;

      await sync.saveCaptured({
        title: defaultTitle(),
        startedAt,
        durationMs: result.durationMs,
        audioUri: result.uri,
        notes,
      });

      setNotes('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not stop recording');
      // Attempt to recover recorder status.
      setRecorderStatus('inactive');
    } finally {
      setBusy(false);
    }
  }, [sync, notes]);

  // ---------------------------------------------------------------------------
  // Render — permission-denied path
  // ---------------------------------------------------------------------------

  if (permission === 'denied') {
    return (
      <div className="view-body capture-view" aria-label="Capture view">
        <p className="capture-permission-denied" data-testid="permission-denied">
          Microphone access was denied. Enable it in device settings to record.
        </p>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render — main capture surface
  // ---------------------------------------------------------------------------

  const isRecording = recorderStatus === 'recording';
  const isActive = recorderStatus !== 'inactive';

  return (
    <div className="view-body capture-view" aria-label="Capture view">
      {/* Status line + VU */}
      <div className="capture-status-row">
        <span
          className={`capture-status-label${isRecording ? ' capture-status-label--recording' : ''}`}
          data-testid="status-label"
          aria-live="polite"
        >
          {recorderStatus === 'inactive' && 'Ready'}
          {recorderStatus === 'recording' && (
            <>
              <span className="capture-rec-dot" aria-hidden="true" />
              Recording
            </>
          )}
          {recorderStatus === 'paused' && 'Paused'}
        </span>

        {isActive && (
          <span
            className="capture-elapsed"
            data-testid="elapsed-timer"
            aria-label={`Elapsed: ${formatElapsed(elapsedSec)}`}
          >
            {formatElapsed(elapsedSec)}
          </span>
        )}
      </div>

      <VuBar amplitude={amplitude} active={isRecording} />

      {/* Primary record control */}
      <div className="capture-record-row">
        <RecordButton
          status={recorderStatus}
          onRecord={handleRecord}
          onPause={handlePause}
          onResume={handleResume}
          onStop={handleStop}
          disabled={busy}
        />
      </div>

      {/* Error display */}
      {error && (
        <p className="capture-error" role="alert" data-testid="capture-error">
          {error}
        </p>
      )}

      {/* Quick-notes — plain textarea, NOT Tiptap */}
      <label className="capture-notes-label" htmlFor="capture-notes">
        Notes
      </label>
      <textarea
        id="capture-notes"
        className="capture-notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Type notes here…"
        aria-label="Quick notes"
        data-testid="notes-field"
        rows={6}
      />
    </div>
  );
}
