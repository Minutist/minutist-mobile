/**
 * Shared time / date formatters used across the capture and meetings views.
 *
 * `formatClock` is the single mm:ss (rolling to h:mm:ss past an hour) clock
 * used for both the live elapsed timer and transcript-segment timestamps;
 * its shape is ported from the desktop's `formatElapsed`
 * (ui/src/shell/RecordingStatus.tsx).  `formatDate` / `formatTime` render an
 * epoch-ms instant as the locale's short date and short time.
 */

/**
 * Format an elapsed-millisecond duration as M:SS, rolling to H:MM:SS past an
 * hour.  Negative inputs clamp to 0.
 */
export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const ss = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mm = totalMinutes % 60;
  const hh = Math.floor(totalMinutes / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

/** Render an epoch-ms instant as the locale's short weekday + date. */
export function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Render an epoch-ms instant as the locale's short time-of-day. */
export function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}
