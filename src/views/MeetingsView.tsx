/**
 * MeetingsView — read-only synced meeting list + captured-unprocessed affordances.
 *
 * Data flows exclusively through the useSync hook; no fixture imports here.
 * - Captured-unprocessed meetings show a "Sync now" button that calls syncMeeting().
 * - Synced meetings are clickable and open MeetingDetail (read-only).
 * - A pairing panel shows myTicket() and an input that calls pair().
 *
 * All styling references theme.css variables only — no hard-coded colours or fonts.
 */

import { useEffect, useRef, useState } from 'react';
import { useSync } from '../sync/useSync';
import type { Meeting, SyncedMeeting, PairingTicket } from '../sync/index';
import { formatClock, formatDate, formatTime } from '../lib/format';
import { SPEAKER_PALETTE_SIZE } from '../lib/speaker-palette';
import './MeetingsView.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ---------------------------------------------------------------------------
// Transcript segment (read-only)
// ---------------------------------------------------------------------------

interface TranscriptRowProps {
  speakerIndex: number;
  startMs: number;
  text: string;
  speakerLabel: string;
}

function TranscriptRow({ speakerIndex, startMs, text, speakerLabel }: TranscriptRowProps) {
  // Map to a 1-based palette slot, cycling past the palette size.
  const palette = ((speakerIndex - 1) % SPEAKER_PALETTE_SIZE) + 1;
  const speakerColor = `var(--speaker-${palette})`;
  return (
    <div className="transcript-row" data-testid="transcript-row">
      <div
        className="transcript-row__speaker"
        style={{ color: speakerColor }}
        aria-label={speakerLabel}
      >
        <span
          className="transcript-row__disc"
          style={{
            background: speakerColor,
            // Hairline edge so the lightest hues still separate from the sheet.
            borderColor: `color-mix(in srgb, ${speakerColor} 55%, var(--ink))`,
          }}
          aria-hidden="true"
        />
        {speakerLabel}
      </div>
      <div className="transcript-row__meta">
        <span className="transcript-row__time">{formatClock(startMs)}</span>
      </div>
      <p className="transcript-row__text">{text}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MeetingDetail — read-only view of a synced meeting
// ---------------------------------------------------------------------------

interface MeetingDetailProps {
  meeting: SyncedMeeting;
  onBack: () => void;
}

function MeetingDetail({ meeting, onBack }: MeetingDetailProps) {
  // Called synchronously inside this render's transcript map — no memoisation
  // needed; a plain lookup keeps it simple.
  const speakerLabel = (index: number): string => {
    if (meeting.speakers && meeting.speakers[index - 1]) {
      return meeting.speakers[index - 1];
    }
    return `Speaker ${index}`;
  };

  return (
    <div className="meeting-detail view-body" aria-label={`Meeting detail: ${meeting.title}`}>
      <button className="back-button" onClick={onBack} aria-label="Back to meetings list">
        ← Meetings
      </button>

      <header className="meeting-detail__header">
        <h2 className="meeting-detail__title">{meeting.title}</h2>
        <p className="meeting-detail__meta">
          {formatDate(meeting.startedAt)} · {formatTime(meeting.startedAt)}
        </p>
      </header>

      {meeting.summary && (
        <section className="meeting-detail__section" aria-labelledby="summary-heading">
          <h3 id="summary-heading" className="meeting-detail__section-heading">
            Summary
          </h3>
          <p className="meeting-detail__summary" data-testid="meeting-summary">
            {meeting.summary}
          </p>
        </section>
      )}

      {meeting.transcript && meeting.transcript.length > 0 && (
        <section
          className="meeting-detail__section meeting-detail__transcript"
          aria-labelledby="transcript-heading"
        >
          <h3 id="transcript-heading" className="meeting-detail__section-heading">
            Transcript
          </h3>
          <div className="transcript-list" data-testid="transcript-list">
            {meeting.transcript.map((seg, i) => (
              <TranscriptRow
                key={i}
                speakerIndex={seg.speakerIndex}
                startMs={seg.startMs}
                text={seg.text}
                speakerLabel={speakerLabel(seg.speakerIndex)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PairingPanel — show own ticket, accept desktop ticket
// ---------------------------------------------------------------------------

interface PairingPanelProps {
  onClose: () => void;
}

function PairingPanel({ onClose }: PairingPanelProps) {
  const sync = useSync();
  const [ownTicket, setOwnTicket] = useState<string>('');
  const [desktopTicket, setDesktopTicket] = useState('');
  const [pairState, setPairState] = useState<'idle' | 'pairing' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [copied, setCopied] = useState(false);
  // Tracks the "Copied" reset timer so it can be cleared if the panel unmounts.
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    sync.myTicket().then(setOwnTicket).catch(() => setOwnTicket('(unavailable)'));
  }, [sync]);

  useEffect(() => () => {
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
  }, []);

  async function handlePair() {
    if (!desktopTicket.trim()) return;
    setPairState('pairing');
    try {
      await sync.pair(desktopTicket.trim() as PairingTicket);
      setPairState('done');
      // Auto-close on successful pair so the toolbar toggle returns to "Pair".
      onClose();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Pairing failed');
      setPairState('error');
    }
  }

  function handleCopy() {
    if (!ownTicket) return;
    void navigator.clipboard.writeText(ownTicket).then(() => {
      setCopied(true);
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
      copyResetRef.current = setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="pairing-panel" aria-label="Pairing panel" role="region">
      <h3 className="pairing-panel__heading">Pair with desktop</h3>

      <p className="pairing-panel__label">This device's ticket</p>
      <div className="pairing-panel__ticket-row">
        <code
          className="pairing-panel__ticket"
          data-testid="own-ticket"
          aria-label="This device's pairing ticket"
        >
          {ownTicket || '…'}
        </code>
        <button
          className="pairing-panel__copy-button"
          onClick={handleCopy}
          disabled={!ownTicket}
          aria-label="Copy this device's pairing ticket"
          data-testid="copy-ticket-button"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className="pairing-panel__divider" role="separator" />

      <label className="pairing-panel__label" htmlFor="desktop-ticket-input">
        Desktop ticket
      </label>
      <input
        id="desktop-ticket-input"
        className="pairing-panel__input"
        type="text"
        value={desktopTicket}
        onChange={(e) => setDesktopTicket(e.target.value)}
        placeholder="Paste the desktop's pairing ticket"
        aria-label="Desktop pairing ticket"
        disabled={pairState === 'pairing'}
      />

      <button
        className="pairing-panel__pair-button"
        onClick={handlePair}
        disabled={pairState === 'pairing' || !desktopTicket.trim()}
        aria-label="Pair with desktop"
      >
        {pairState === 'pairing' ? 'Pairing…' : 'Pair'}
      </button>

      {pairState === 'error' && (
        <p className="pairing-panel__status pairing-panel__status--error" role="alert">
          {errorMsg}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MeetingListRow
// ---------------------------------------------------------------------------

interface MeetingRowProps {
  meeting: Meeting;
  onSelect: (id: string) => void;
  onSyncNow: (id: string) => void;
  syncingId: string | null;
}

function MeetingRow({ meeting, onSelect, onSyncNow, syncingId }: MeetingRowProps) {
  const isSyncing = syncingId === meeting.id;

  if (meeting.state === 'captured-unprocessed') {
    return (
      <div
        className="meeting-row meeting-row--captured"
        data-testid={`meeting-row-${meeting.id}`}
        aria-label={`${meeting.title}, recorded, awaiting a desktop`}
      >
        <div className="meeting-row__body">
          <p className="meeting-row__title">{meeting.title}</p>
          <p className="meeting-row__meta">
            {formatDate(meeting.startedAt)} · {formatTime(meeting.startedAt)} ·{' '}
            {formatDuration(meeting.durationMs)}
          </p>
          <p className="meeting-row__badge">Recorded — awaiting a desktop</p>
        </div>
        <button
          className="meeting-row__sync-button"
          onClick={() => onSyncNow(meeting.id)}
          disabled={isSyncing}
          data-testid={`sync-button-${meeting.id}`}
        >
          {isSyncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
    );
  }

  // state === 'synced'
  return (
    <button
      className="meeting-row meeting-row--synced"
      data-testid={`meeting-row-${meeting.id}`}
      onClick={() => onSelect(meeting.id)}
      aria-label={`Open ${meeting.title}`}
    >
      <div className="meeting-row__body">
        <p className="meeting-row__title">{meeting.title}</p>
        <p className="meeting-row__meta">
          {formatDate(meeting.startedAt)} · {formatTime(meeting.startedAt)}
        </p>
        {meeting.summary && (
          <p className="meeting-row__snippet">{meeting.summary}</p>
        )}
      </div>
      <span className="meeting-row__chevron" aria-hidden="true">›</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// MeetingsView (root export)
// ---------------------------------------------------------------------------

export function MeetingsView() {
  const sync = useSync();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [pairingOpen, setPairingOpen] = useState(false);

  // Seed from the initial snapshot then keep in sync via subscription.
  // onMeetingsChanged delivers updates for any mutation — local or remote.
  // Subscribe BEFORE reading the snapshot so no update is missed in between, and
  // let any live update supersede a later-resolving (staler) initial snapshot.
  useEffect(() => {
    let cancelled = false;
    let updateApplied = false;

    const unsub = sync.onMeetingsChanged((list) => {
      if (cancelled) return;
      updateApplied = true;
      setMeetings(list);
      setLoading(false);
    });

    sync.listMeetings().then((list) => {
      if (cancelled || updateApplied) return;
      setMeetings(list);
      setLoading(false);
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [sync]);

  async function handleSyncNow(id: string) {
    setSyncingId(id);
    try {
      // Begin pushing — the captured→synced transition arrives via onMeetingsChanged.
      await sync.syncMeeting(id);
    } finally {
      setSyncingId(null);
    }
  }

  const selectedMeeting =
    selectedId != null ? meetings.find((m) => m.id === selectedId) : undefined;

  if (selectedMeeting?.state === 'synced') {
    return (
      <MeetingDetail
        meeting={selectedMeeting}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <div className="meetings-view view-body" aria-label="Meetings view">
      <div className="meetings-view__toolbar">
        <h2 className="meetings-view__heading">Meetings</h2>
        <button
          className="meetings-view__pair-toggle"
          onClick={() => setPairingOpen((o) => !o)}
          aria-expanded={pairingOpen}
          aria-label="Toggle pairing panel"
        >
          {pairingOpen ? 'Done' : 'Pair'}
        </button>
      </div>

      {pairingOpen && <PairingPanel onClose={() => setPairingOpen(false)} />}

      <div role="separator" className="meetings-view__rule" />

      {loading ? (
        <p className="meetings-view__empty">Loading…</p>
      ) : meetings.length === 0 ? (
        <p className="meetings-view__empty">
          No meetings yet. Record one with the Capture tab.
        </p>
      ) : (
        <ul className="meetings-list" aria-label="Meeting list">
          {meetings.map((m) => (
            <li key={m.id} className="meetings-list__item">
              <MeetingRow
                meeting={m}
                onSelect={setSelectedId}
                onSyncNow={handleSyncNow}
                syncingId={syncingId}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
