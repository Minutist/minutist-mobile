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
import { App as CapacitorApp } from '@capacitor/app';
import { Share } from '@capacitor/share';
import { useSync } from '../sync/useSync';
import type { Meeting, SyncedMeeting, PairingTicket } from '../sync/index';
import { formatClock, formatDate, formatTime } from '../lib/format';
import { SPEAKER_PALETTE_SIZE } from '../lib/speaker-palette';
import { parseMarkdownBlocks, extractSnippet, stripMarkdown } from '../lib/markdown';
import type { MarkdownBlock } from '../lib/markdown';
import { SignInPanel } from '../account/SignInPanel';
import { getStoredCredential, clearStoredCredential } from '../account/signin';
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
// Markdown renderer
// ---------------------------------------------------------------------------

/**
 * Render inline **bold** markers within a text string.
 * Returns an array of strings and <strong> elements.
 */
function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*.+?\*\*)/g);
  return parts.map((part, i) => {
    const boldMatch = /^\*\*(.+)\*\*$/.exec(part);
    if (boldMatch) {
      return <strong key={i}>{boldMatch[1]}</strong>;
    }
    return part;
  });
}

/**
 * Render a parsed MarkdownBlock[] as JSX.
 *
 * Heading levels use --font-display (Fraunces) with variation-settings
 * matching the detail view's existing heading style. List items and
 * paragraphs use --font-text at the body size.
 */
function renderMarkdownBlocks(blocks: MarkdownBlock[]): React.ReactNode {
  return blocks.map((block, i) => {
    switch (block.kind) {
      case 'h2':
        return (
          <h4 key={i} className="meeting-detail__md-h2">
            {renderInline(block.text)}
          </h4>
        );
      case 'h3':
        return (
          <h4 key={i} className="meeting-detail__md-h3">
            {renderInline(block.text)}
          </h4>
        );
      case 'ul':
        return (
          <ul key={i} className="meeting-detail__md-ul">
            {block.items.map((item, j) => (
              <li key={j} className="meeting-detail__md-li">
                {renderInline(item)}
              </li>
            ))}
          </ul>
        );
      case 'p':
        return (
          <p key={i} className="meeting-detail__md-p">
            {renderInline(block.text)}
          </p>
        );
    }
  });
}

// ---------------------------------------------------------------------------
// Inline glyphs
// ---------------------------------------------------------------------------

/** Share glyph — a node-and-links share symbol. */
function ShareIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="15" cy="4" r="2.25" />
      <circle cx="5" cy="10" r="2.25" />
      <circle cx="15" cy="16" r="2.25" />
      <line x1="7" y1="8.9" x2="13" y2="5.1" />
      <line x1="7" y1="11.1" x2="13" y2="14.9" />
    </svg>
  );
}

/** Refresh glyph — a circular arrow. */
function RefreshIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M16.5 6.5A7 7 0 1 0 17 10" />
      <polyline points="16.5 3 16.5 6.5 13 6.5" />
    </svg>
  );
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
      <span
        className="transcript-row__chip"
        style={{
          background: `color-mix(in srgb, ${speakerColor} 16%, var(--sheet-quiet))`,
          border: `1px solid color-mix(in srgb, ${speakerColor} 40%, transparent)`,
          color: speakerColor,
        }}
        aria-label={speakerLabel}
      >
        {speakerLabel}
      </span>
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

  // Assemble a plain-text share body: title, then the summary (markdown
  // stripped) and the transcript with speaker labels.
  const buildShareText = (): string => {
    const parts: string[] = [];
    if (meeting.summary) {
      parts.push('Summary', stripMarkdown(meeting.summary));
    }
    if (meeting.transcript && meeting.transcript.length > 0) {
      parts.push(
        'Transcript',
        meeting.transcript
          .map((seg) => `${speakerLabel(seg.speakerIndex)}: ${seg.text}`)
          .join('\n'),
      );
    }
    return parts.join('\n\n');
  };

  const handleShare = async () => {
    try {
      await Share.share({
        title: meeting.title,
        text: buildShareText(),
        dialogTitle: 'Share meeting',
      });
    } catch {
      // Share unavailable (web / test env) or user cancelled — no-op.
    }
  };

  return (
    <div className="meeting-detail view-body" aria-label={`Meeting detail: ${meeting.title}`}>
      <div className="meeting-detail__header-row">
        <button className="back-button" onClick={onBack} aria-label="Back to meetings list">
          ← Meetings
        </button>
        <button
          className="share-button"
          onClick={() => void handleShare()}
          aria-label="Share meeting"
          data-testid="share-button"
        >
          <ShareIcon />
          Share
        </button>
      </div>

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
          <div className="meeting-detail__summary" data-testid="meeting-summary">
            {renderMarkdownBlocks(parseMarkdownBlocks(meeting.summary))}
          </div>
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
    // 'claimed' = a host has adopted it and is producing outputs (no results
    // yet): show a non-interactive "Processing…" affordance, NOT a Sync button.
    // 'pending' (or absent) = offered/awaiting sync: show "Retry sync".
    const claimed = meeting.processing === 'claimed';
    const badge = claimed
      ? meeting.claimedBy
        ? `Processing on ${meeting.claimedBy}…`
        : 'Processing…'
      : 'Recorded — awaiting sync';
    return (
      <div
        className={`meeting-row meeting-row--captured${claimed ? ' meeting-row--processing' : ''}`}
        data-testid={`meeting-row-${meeting.id}`}
        aria-label={
          claimed
            ? `${meeting.title}, ${meeting.claimedBy ? `processing on ${meeting.claimedBy}` : 'processing'}`
            : `${meeting.title}, recorded, awaiting sync`
        }
      >
        <div className="meeting-row__body">
          <p className="meeting-row__title">{meeting.title}</p>
          <p className="meeting-row__meta">
            {formatDate(meeting.startedAt)} · {formatTime(meeting.startedAt)} ·{' '}
            {formatDuration(meeting.durationMs)}
          </p>
          <p className="meeting-row__badge">{badge}</p>
        </div>
        {claimed ? (
          <span
            className="meeting-row__processing"
            data-testid={`processing-${meeting.id}`}
            aria-hidden="true"
          >
            ⋯
          </span>
        ) : (
          <button
            className="meeting-row__sync-button"
            onClick={() => onSyncNow(meeting.id)}
            disabled={isSyncing}
            data-testid={`sync-button-${meeting.id}`}
          >
            {isSyncing ? 'Syncing…' : 'Retry sync'}
          </button>
        )}
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
          <p className="meeting-row__snippet">{extractSnippet(meeting.summary)}</p>
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
  const [signInOpen, setSignInOpen] = useState(false);
  const [accountCredential, setAccountCredential] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Mirror the nav state into refs so the Android back-button listener (bound
  // once) can read the latest values without re-subscribing on every change.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const pairingOpenRef = useRef(pairingOpen);
  pairingOpenRef.current = pairingOpen;
  const signInOpenRef = useRef(signInOpen);
  signInOpenRef.current = signInOpen;

  // Load any stored account credential from secure-storage on mount.
  useEffect(() => {
    getStoredCredential().then(setAccountCredential).catch(() => {});
  }, []);

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

  // Android hardware/system back button (A10).  Pop MeetingDetail → list, then
  // close the pairing panel → list, else fall through to the OS default (exit).
  // The listener is bound once; it reads live nav state via refs.  Guarded so it
  // is a no-op on web / in tests where @capacitor/app has no native bridge.
  useEffect(() => {
    let remove: (() => void) | undefined;
    CapacitorApp.addListener('backButton', ({ canGoBack }) => {
      if (selectedIdRef.current != null) {
        setSelectedId(null);
      } else if (signInOpenRef.current) {
        setSignInOpen(false);
      } else if (pairingOpenRef.current) {
        setPairingOpen(false);
      } else if (!canGoBack) {
        void CapacitorApp.exitApp();
      }
    })
      .then((handle) => {
        remove = () => void handle.remove();
      })
      .catch(() => {
        // No native bridge (web / test) — nothing to bind.
      });
    return () => remove?.();
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const list = await sync.listMeetings();
      setMeetings(list);
    } finally {
      setRefreshing(false);
    }
  }

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
        <div className="meetings-view__toolbar-actions">
          <button
            className="meetings-view__refresh-button"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            aria-label="Refresh meetings"
            data-testid="refresh-button"
          >
            <RefreshIcon />
          </button>
          {accountCredential ? (
            <span className="meetings-view__signed-in" data-testid="signed-in-indicator">
              Signed in
              <button
                className="meetings-view__signout-button"
                onClick={() => {
                  void clearStoredCredential().then(() => setAccountCredential(null));
                }}
                aria-label="Sign out"
                data-testid="signout-button"
              >
                Sign out
              </button>
            </span>
          ) : (
            <button
              className="meetings-view__signin-toggle"
              onClick={() => setSignInOpen((o) => !o)}
              aria-expanded={signInOpen}
              aria-label="Sign in to sync"
              data-testid="signin-button"
            >
              {signInOpen ? 'Cancel' : 'Sign in'}
            </button>
          )}
          <button
            className="meetings-view__pair-toggle"
            onClick={() => setPairingOpen((o) => !o)}
            aria-expanded={pairingOpen}
            aria-label="Toggle pairing panel"
          >
            {pairingOpen ? 'Done' : 'Pair'}
          </button>
        </div>
      </div>

      {signInOpen && (
        <SignInPanel
          onSignedIn={(cred) => {
            setAccountCredential(cred);
            setSignInOpen(false);
          }}
          onCancel={() => setSignInOpen(false)}
        />
      )}

      {pairingOpen && <PairingPanel onClose={() => setPairingOpen(false)} />}

      <div role="separator" className="meetings-view__rule" />

      {loading ? (
        <p className="meetings-view__empty">Loading…</p>
      ) : meetings.length === 0 ? (
        <div className="meetings-view__empty-state" data-testid="empty-state">
          {!accountCredential && (
            <button
              className="meetings-view__empty-signin-cta"
              onClick={() => setSignInOpen(true)}
              data-testid="empty-signin-cta"
            >
              Sign in to sync your meetings
            </button>
          )}
          <p className="meetings-view__empty">No meetings yet.</p>
          <p className="meetings-view__empty-hint">
            Switch to the Capture tab to record your first meeting.
          </p>
        </div>
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
