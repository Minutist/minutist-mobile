/**
 * Device-authorization sign-in flow (RFC 8628).
 *
 * Drives pairStart → display codes → poll until authorised → store credential.
 */
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import type { AccountClient, PairStartResponse } from './client';

export const CREDENTIAL_KEY = 'account.device_credential';

export interface SignInProgress {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
}

export type SignInResult =
  | { outcome: 'authorised'; credential: string; accountId: string }
  | { outcome: 'expired' }
  | { outcome: 'denied' }
  | { outcome: 'error'; message: string };

/**
 * Run the device-code sign-in flow. Calls `onProgress` with the user-code and
 * verification URL so the UI can display them before polling begins, then
 * polls until authorised or the code expires.
 */
export async function deviceCodeSignIn(
  client: AccountClient,
  onProgress: (p: SignInProgress) => void,
  signal?: AbortSignal,
): Promise<SignInResult> {
  let start: PairStartResponse;
  try {
    start = await client.pairStart();
  } catch (err) {
    return { outcome: 'error', message: err instanceof Error ? err.message : String(err) };
  }

  onProgress({
    userCode: start.user_code,
    verificationUri: start.verification_uri,
    verificationUriComplete: start.verification_uri_complete,
    expiresIn: start.expires_in,
  });

  const deadline = Date.now() + start.expires_in * 1000;
  // interval comes from the server (RFC 8628 minimum is 5s); honour slow_down by doubling.
  let intervalMs = Math.max(start.interval, 5) * 1000;

  while (Date.now() < deadline) {
    if (signal?.aborted) return { outcome: 'error', message: 'aborted' };

    await sleep(intervalMs, signal);
    if (signal?.aborted) return { outcome: 'error', message: 'aborted' };

    let poll;
    try {
      poll = await client.pairPoll(start.device_code);
    } catch (err) {
      return { outcome: 'error', message: err instanceof Error ? err.message : String(err) };
    }

    if (poll.status === 'authorised' && poll.device_credential && poll.account_id) {
      await SecureStorage.set(CREDENTIAL_KEY, poll.device_credential);
      return {
        outcome: 'authorised',
        credential: poll.device_credential,
        accountId: poll.account_id,
      };
    }
    if (poll.status === 'slow_down') {
      intervalMs = Math.min(intervalMs * 2, 30_000);
    }
    if (poll.status === 'expired_token') return { outcome: 'expired' };
    if (poll.status === 'access_denied') return { outcome: 'denied' };
    // authorization_pending — keep polling
  }
  return { outcome: 'expired' };
}

/** Read the stored account credential, or null if none. */
export async function getStoredCredential(): Promise<string | null> {
  try {
    const result = await SecureStorage.get(CREDENTIAL_KEY);
    if (result === null || result === undefined) return null;
    // SecureStorage.get returns the stored DataType directly; we only ever
    // store strings, so cast is safe.
    return result as string;
  } catch {
    return null;
  }
}

/**
 * Write a pre-minted credential string directly into Keystore-encrypted
 * storage, bypassing the interactive device-code flow. The value goes through
 * the plugin's own SecureStorage.set (Android Keystore + EncryptedSharedPrefs)
 * so it is protected identically to a credential obtained via sign-in.
 *
 * Call this in DEBUG builds only, before any ensureStarted() / syncAccountPeers()
 * runs, so the auto-register path picks it up on first boot.
 */
export async function seedCredential(cred: string): Promise<void> {
  await SecureStorage.set(CREDENTIAL_KEY, cred);
}

/** Clear the stored credential (sign out). */
export async function clearStoredCredential(): Promise<void> {
  try {
    await SecureStorage.remove(CREDENTIAL_KEY);
  } catch {
    // not present — no-op
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(id);
        resolve();
      },
      { once: true },
    );
  });
}
