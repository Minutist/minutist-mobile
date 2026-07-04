/**
 * SignInPanel — device-code sign-in flow (B3/B5).
 *
 * Drives deviceCodeSignIn: shows the user_code + verification URL, opens
 * the browser for the user to authorise, polls until done, calls onSignedIn
 * on success. Cancels polling when unmounted.
 */
import { useEffect, useRef, useState } from 'react';
import { Browser } from '@capacitor/browser';
import { accountClient } from './client';
import { deviceCodeSignIn } from './signin';
import type { SignInProgress } from './signin';
import './SignInPanel.css';

interface SignInPanelProps {
  onSignedIn: (credential: string, accountId: string) => void;
  onCancel: () => void;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'polling'; progress: SignInProgress }
  | { kind: 'error'; message: string };

function runSignIn(
  abort: AbortController,
  onProgress: (p: SignInProgress) => void,
  onResult: (phase: Phase) => void,
  onSignedIn: (credential: string, accountId: string) => void,
): void {
  void deviceCodeSignIn(accountClient, onProgress, abort.signal).then((result) => {
    if (abort.signal.aborted) return;
    if (result.outcome === 'authorised') {
      onSignedIn(result.credential, result.accountId);
    } else if (result.outcome === 'expired') {
      onResult({ kind: 'error', message: 'The sign-in code expired. Tap to try again.' });
    } else if (result.outcome === 'denied') {
      onResult({ kind: 'error', message: 'Sign-in was denied. Tap to try again.' });
    } else {
      onResult({ kind: 'error', message: result.message });
    }
  });
}

export function SignInPanel({ onSignedIn, onCancel }: SignInPanelProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    abortRef.current = abort;
    setPhase({ kind: 'starting' });
    runSignIn(
      abort,
      (progress) => setPhase({ kind: 'polling', progress }),
      setPhase,
      onSignedIn,
    );
    return () => {
      abort.abort();
    };
  }, [onSignedIn]);

  function handleRetry() {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setPhase({ kind: 'starting' });
    runSignIn(
      abort,
      (progress) => setPhase({ kind: 'polling', progress }),
      setPhase,
      onSignedIn,
    );
  }

  async function openBrowser(url: string) {
    try {
      await Browser.open({ url });
    } catch {
      // Fallback for web/test env.
    }
  }

  return (
    <div className="signin-panel" aria-label="Sign-in panel" role="region">
      <h3 className="signin-panel__heading">Sign in to sync</h3>

      {(phase.kind === 'idle' || phase.kind === 'starting') && (
        <p className="signin-panel__hint">Starting sign-in…</p>
      )}

      {phase.kind === 'polling' && (
        <>
          <p className="signin-panel__hint">
            Enter this code on the sign-in page to connect your account:
          </p>
          <p
            className="signin-panel__user-code"
            data-testid="user-code"
            aria-label="Sign-in code"
          >
            {phase.progress.userCode}
          </p>
          <button
            className="signin-panel__open-button"
            onClick={() =>
              void openBrowser(
                phase.progress.verificationUriComplete ?? phase.progress.verificationUri,
              )
            }
            data-testid="open-signin-page"
            aria-label="Open sign-in page"
          >
            Open sign-in page
          </button>
          <p className="signin-panel__status">Waiting for authorisation…</p>
        </>
      )}

      {phase.kind === 'error' && (
        <>
          <p className="signin-panel__error" role="alert">
            {phase.message}
          </p>
          <button className="signin-panel__retry-button" onClick={handleRetry}>
            Try again
          </button>
        </>
      )}

      <button
        className="signin-panel__cancel-button"
        onClick={onCancel}
        aria-label="Cancel sign-in"
      >
        Cancel
      </button>
    </div>
  );
}
