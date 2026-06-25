/**
 * CaptureView — record control, elapsed timer, VU meter, and quick-notes.
 *
 * Consumes the recorder facade via RecorderContext and the sync client via
 * useSync.  On stop it persists the recording as a captured-unprocessed meeting
 * via SyncClient.saveCaptured and calls onNavigateToMeetings so the app shell
 * can switch to the Meetings tab.
 *
 * Design constraints:
 * - All colours / fonts / radii reference theme.css variables only.
 * - The quick-notes field is a plain <textarea>, NOT Tiptap.
 * - No ML, no transcription, no Opus code anywhere in this file.
 * - Plugin calls are guarded: if the recorder facade throws (web / test env
 *   without a real plugin) the view degrades gracefully.
 */

import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { useRecorder } from '../capture/RecorderContext';
import type { MicPermission, RecorderStatus } from '../capture/RecorderContext';
import { platformForegroundServiceController, requestNotificationPermission } from '../capture/foregroundService';
import { transcodeAacToOpus } from '../capture/opusTranscode';
import { useSync } from '../sync/useSync';
import { formatClock, formatDate, formatTime } from '../lib/format';
import './CaptureView.css';
import type { RecordingStoppedEvent, RecordingErrorEvent } from '../capture/RecorderContext';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a default meeting title from the current local time. */
function defaultTitle(): string {
  const now = Date.now();
  return `${formatDate(now)} · ${formatTime(now)}`;
}

/** Status-line labels by recorder state (the rec-dot is a special case). */
const STATUS_LABEL: Record<RecorderStatus, string> = {
  inactive: 'Ready',
  recording: 'Recording',
  paused: 'Paused',
};

// ---------------------------------------------------------------------------
// VU bar — lightweight amplitude visualiser
// ---------------------------------------------------------------------------

interface VuBarProps {
  /**
   * Ref to the fill element.  The amplitude poll writes the fill width
   * directly to this element (the bar is aria-hidden decorative), so the
   * frequent amplitude updates never trigger a React render.  The width is
   * zeroed when recording is not active.
   */
  fillRef: React.RefObject<HTMLDivElement | null>;
}

function VuBar({ fillRef }: VuBarProps) {
  return (
    <div
      className="capture-vu"
      aria-hidden="true"
      data-testid="vu-bar"
    >
      <div ref={fillRef} className="capture-vu__fill" />
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

const RecordButton = memo(function RecordButton({
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
});

// ---------------------------------------------------------------------------
// CaptureView (root export)
// ---------------------------------------------------------------------------

export interface CaptureViewProps {
  /**
   * Called after a recording is saved as a captured-unprocessed meeting.
   * The app shell uses this to navigate to the Meetings tab so the user
   * can see and optionally sync the new item.
   */
  onNavigateToMeetings?: () => void;
}

export function CaptureView({ onNavigateToMeetings }: CaptureViewProps = {}) {
  const recorder = useRecorder();
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

  // VU bar fill element — the amplitude poll writes its width directly so the
  // frequent updates never trigger a React render (the bar is decorative).
  const vuFillRef = useRef<HTMLDivElement | null>(null);

  // Quick-notes textarea content.
  const [notes, setNotes] = useState('');
  // Ref for notes textarea so we can scrollIntoView on focus.
  const notesRef = useRef<HTMLTextAreaElement | null>(null);

  // Transient UI state.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Set to true at the start of a user-initiated handleStop, cleared on completion.
  // Used by the plugin-event handlers to distinguish user-initiated from unsolicited stops.
  const stoppingRef = useRef(false);

  // Unique identifier for the current capture session, set at recording start.
  // Used to name the per-capture output directory for the transcoded audio.opus.
  const captureIdRef = useRef<string | null>(null);

  // ---------------------------------------------------------------------------
  // Check permission on mount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    recorder.checkPermission()
      .then(setPermission)
      .catch(() => {
        // Plugin unavailable (web / test without real bridge) — treat as prompt.
        setPermission('prompt');
      });
    // recorder is stable for the component lifetime — check runs once on mount.
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
    }, 1000);

    return () => clearInterval(id);
  }, [recorderStatus]);

  // ---------------------------------------------------------------------------
  // Amplitude polling (~80 ms) — only while actively recording.  The value is
  // written straight to the VU fill element's width via the ref so the poll
  // never re-renders the view.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const fill = vuFillRef.current;

    if (recorderStatus !== 'recording') {
      if (fill) fill.style.width = '0%';
      return;
    }

    const id = setInterval(async () => {
      try {
        const v = await recorder.getAmplitude();
        if (vuFillRef.current) {
          vuFillRef.current.style.width = `${Math.round(v * 100)}%`;
        }
      } catch {
        // Plugin unavailable; ignore.
      }
    }, 80);

    return () => clearInterval(id);
  }, [recorderStatus, recorder]);

  // Stable refs for values consumed inside plugin-event handlers.
  // Avoids re-subscribing on every render while still reading the latest values.
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const notesRef2 = useRef(notes);
  notesRef2.current = notes;
  const onNavigateRef = useRef(onNavigateToMeetings);
  onNavigateRef.current = onNavigateToMeetings;

  // ---------------------------------------------------------------------------
  // Plugin event subscriptions — unsolicited stop / error reconciliation
  //
  // stoppingRef gates the handlers: when true, handleStop owns the lifecycle
  // and the event is a no-op here (the user-initiated path already covers it).
  // When false, the OS or plugin stopped recording without user action; we
  // reconcile the UI back to inactive, tear down the foreground service, and,
  // if the event carries a usable file, save the meeting then navigate.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const unsubStopped = recorder.onStopped((event: RecordingStoppedEvent) => {
      if (stoppingRef.current) return; // user-initiated stop — handled by handleStop

      // Unsolicited stop: reconcile to inactive.
      setRecorderStatus('inactive');
      setElapsedSec(0);
      accumulatedSecRef.current = 0;
      startWallRef.current = null;

      void platformForegroundServiceController.onAfterStop();

      const startedAt = sessionStartRef.current ?? (event.duration != null ? Date.now() - event.duration : Date.now());
      sessionStartRef.current = null;

      if (event.uri && event.duration != null) {
        // Transcode then save from the unsolicited stop.
        const captureId = captureIdRef.current ?? `cap-${startedAt.toString(36)}`;
        captureIdRef.current = null;
        void (async () => {
          let audioUri = event.uri!;
          try {
            const tx = await transcodeAacToOpus(captureId, event.uri!);
            if (tx.opusPath) audioUri = `file://${tx.opusPath}`;
          } catch {
            // Non-fatal: fall back to AAC URI.
          }
          return syncRef.current.saveCaptured({
            title: defaultTitle(),
            startedAt,
            durationMs: event.duration!,
            audioUri,
            notes: notesRef2.current,
          });
        })()
          .then(() => {
            setNotes('');
            onNavigateRef.current?.();
          })
          .catch((err: unknown) => {
            setError(err instanceof Error ? err.message : 'Could not save recording');
          });
      } else {
        setError('Recording ended unexpectedly.');
      }
    });

    const unsubError = recorder.onError((event: RecordingErrorEvent) => {
      setError(event.message ?? 'Recording error');
      setRecorderStatus('inactive');
      setElapsedSec(0);
      accumulatedSecRef.current = 0;
      startWallRef.current = null;
      sessionStartRef.current = null;

      void platformForegroundServiceController.onAfterStop();
    });

    return () => {
      unsubStopped();
      unsubError();
    };
  }, [recorder]);

  // ---------------------------------------------------------------------------
  // Record / pause / resume / stop handlers
  // ---------------------------------------------------------------------------

  const handleRecord = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      let perm = permission;
      if (perm !== 'granted') {
        // Request RECORD_AUDIO and POST_NOTIFICATIONS together so both prompts
        // appear in the same user-initiated gesture.  POST_NOTIFICATIONS is
        // required on Android 13+ to show the ongoing recording notification;
        // its result is informational — recording proceeds regardless.
        [perm] = await Promise.all([
          recorder.requestPermission(),
          requestNotificationPermission(),
        ]);
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
      // Generate a stable per-session ID used to name the Opus output directory.
      captureIdRef.current = `cap-${now.toString(36)}`;
      await recorder.start(undefined, platformForegroundServiceController);
      setRecorderStatus('recording');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start recording');
    } finally {
      setBusy(false);
    }
  }, [recorder, permission]);

  const handlePause = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await recorder.pause();
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
  }, [recorder]);

  const handleResume = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await recorder.resume();
      startWallRef.current = Date.now();
      setRecorderStatus('recording');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resume');
    } finally {
      setBusy(false);
    }
  }, [recorder]);

  const handleStop = useCallback(async () => {
    setError(null);
    setBusy(true);
    stoppingRef.current = true;
    try {
      const result = await recorder.stop(platformForegroundServiceController);
      setRecorderStatus('inactive');
      setElapsedSec(0);
      accumulatedSecRef.current = 0;
      startWallRef.current = null;

      const startedAt = sessionStartRef.current ?? Date.now() - result.durationMs;
      sessionStartRef.current = null;

      // Transcode AAC → 16 kHz mono Ogg-Opus on API 29+.  On older devices
      // opusPath is absent and the raw AAC URI is passed to sync instead.
      const captureId = captureIdRef.current ?? `cap-${startedAt.toString(36)}`;
      captureIdRef.current = null;
      let audioUri = result.uri;
      try {
        const tx = await transcodeAacToOpus(captureId, result.uri);
        if (tx.opusPath) audioUri = `file://${tx.opusPath}`;
      } catch {
        // Transcode failure is non-fatal: fall back to the AAC URI.
      }

      // Keep busy=true so the "Saving…" label stays visible until save resolves.
      await sync.saveCaptured({
        title: defaultTitle(),
        startedAt,
        durationMs: result.durationMs,
        audioUri,
        notes,
      });

      setNotes('');
      // Navigate to Meetings so the user can see and sync the new item.
      onNavigateToMeetings?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not stop recording');
      // Attempt to recover recorder status.
      setRecorderStatus('inactive');
    } finally {
      stoppingRef.current = false;
      setBusy(false);
    }
  }, [recorder, sync, notes, onNavigateToMeetings]);

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
  // During the async save window between stop and navigate, show "Saving…"
  // so the tab switch isn't abrupt and unexplained (mirrors desktop "Finalising…").
  const savingLabel = busy && recorderStatus === 'inactive';

  return (
    <div className="view-body capture-view" aria-label="Capture view">
      {/* Status line + VU */}
      <div className="capture-status-row">
        <span
          className={`capture-status-label${isRecording ? ' capture-status-label--recording' : ''}`}
          data-testid="status-label"
          aria-live="polite"
        >
          {isRecording && <span className="capture-rec-dot" aria-hidden="true" />}
          {savingLabel ? 'Saving…' : STATUS_LABEL[recorderStatus]}
        </span>

        {isActive && (
          <span
            className="capture-elapsed"
            data-testid="elapsed-timer"
            aria-label={`Elapsed: ${formatClock(elapsedSec * 1000)}`}
          >
            {formatClock(elapsedSec * 1000)}
          </span>
        )}
      </div>

      <VuBar fillRef={vuFillRef} />

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
        ref={notesRef}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        onFocus={() => notesRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })}
        placeholder="Type notes here…"
        aria-label="Quick notes"
        data-testid="notes-field"
        rows={6}
      />
    </div>
  );
}
