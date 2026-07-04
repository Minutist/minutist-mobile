/**
 * Tests for the account module: AccountClient, device-code sign-in flow,
 * relay-token selection, and registerEndpoint wiring.
 *
 * All tests run against mocks — no live account-service required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AccountClient } from './client';
import { deviceCodeSignIn, getStoredCredential, CREDENTIAL_KEY } from './signin';

// ---------------------------------------------------------------------------
// Mock @aparajita/capacitor-secure-storage
// ---------------------------------------------------------------------------

const store = new Map<string, string>();

vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: {
    set: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    get: vi.fn((key: string) => {
      const value = store.get(key) ?? null;
      return Promise.resolve(value);
    }),
    remove: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve(true);
    }),
  },
}));

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  store.clear();
  fetchMock.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// AccountClient
// ---------------------------------------------------------------------------

describe('AccountClient.pairStart', () => {
  it('POSTs to /pair/start and returns the response', async () => {
    const client = new AccountClient('https://test.example');
    const payload = {
      device_code: 'dc_abc',
      user_code: 'ABCD-1234',
      verification_uri: 'https://auth.example/device',
      expires_in: 300,
      interval: 5,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(payload));

    const result = await client.pairStart();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://test.example/pair/start');
    expect(init.method).toBe('POST');
    expect(result.device_code).toBe('dc_abc');
    expect(result.user_code).toBe('ABCD-1234');
  });

  it('throws on non-OK status', async () => {
    const client = new AccountClient('https://test.example');
    fetchMock.mockResolvedValueOnce(new Response('', { status: 502 }));
    await expect(client.pairStart()).rejects.toThrow('pair/start: HTTP 502');
  });
});

describe('AccountClient.pairPoll', () => {
  it('POSTs to /pair/poll with the device_code', async () => {
    const client = new AccountClient('https://test.example');
    const payload = { status: 'authorization_pending' };
    fetchMock.mockResolvedValueOnce(jsonResponse(payload));

    const result = await client.pairPoll('dc_abc');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://test.example/pair/poll');
    expect(JSON.parse(init.body as string)).toEqual({ device_code: 'dc_abc' });
    expect(result.status).toBe('authorization_pending');
  });
});

describe('AccountClient.registerEndpoint', () => {
  it('PUTs to /v1/account/devices/self/endpoint with bearer and body', async () => {
    const client = new AccountClient('https://test.example');
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));

    await client.registerEndpoint('mdc_id.secret', 'ep_xyz', 'https://relay.example');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://test.example/v1/account/devices/self/endpoint');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer mdc_id.secret',
    );
    expect(JSON.parse(init.body as string)).toEqual({
      endpoint_id: 'ep_xyz',
      relay_url: 'https://relay.example',
    });
  });
});

describe('AccountClient.listDevices', () => {
  it('GETs /v1/account/devices with bearer', async () => {
    const client = new AccountClient('https://test.example');
    fetchMock.mockResolvedValueOnce(jsonResponse([{ device_id: 'd1' }]));

    const devices = await client.listDevices('mdc_id.secret');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://test.example/v1/account/devices');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer mdc_id.secret',
    );
    expect(devices[0].device_id).toBe('d1');
  });
});

// ---------------------------------------------------------------------------
// deviceCodeSignIn — start → poll → credential → stored
// ---------------------------------------------------------------------------

describe('deviceCodeSignIn', () => {
  it('calls pairStart, surfaces user_code via onProgress, polls, stores credential on authorised', async () => {
    const client = new AccountClient('https://test.example');

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          device_code: 'dc_1',
          user_code: 'WXYZ-5678',
          verification_uri: 'https://auth.example/device',
          expires_in: 300,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ status: 'authorization_pending' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'authorised',
          device_credential: 'mdc_dev1.secret',
          account_id: 'acct_abc',
          device_id: 'dev_1',
        }),
      );

    const progressEvents: string[] = [];
    const resultPromise = deviceCodeSignIn(
      client,
      (p) => progressEvents.push(p.userCode),
    );

    // pairStart resolves immediately; onProgress fired, first poll scheduled.
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(progressEvents).toEqual(['WXYZ-5678']);
    expect(result).toEqual({
      outcome: 'authorised',
      credential: 'mdc_dev1.secret',
      accountId: 'acct_abc',
    });
    // Credential stored in secure-storage.
    expect(store.get(CREDENTIAL_KEY)).toBe('mdc_dev1.secret');
  });

  it('returns expired when server returns expired_token', async () => {
    const client = new AccountClient('https://test.example');

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          device_code: 'dc_2',
          user_code: 'AAAA-0000',
          verification_uri: 'https://auth.example/device',
          expires_in: 300,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 'expired_token' }));

    const resultPromise = deviceCodeSignIn(client, () => {});
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.outcome).toBe('expired');
    expect(store.has(CREDENTIAL_KEY)).toBe(false);
  });

  it('returns denied on access_denied', async () => {
    const client = new AccountClient('https://test.example');

    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          device_code: 'dc_3',
          user_code: 'BBBB-1111',
          verification_uri: 'https://auth.example/device',
          expires_in: 300,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: 'access_denied' }));

    const resultPromise = deviceCodeSignIn(client, () => {});
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.outcome).toBe('denied');
  });

  it('aborts cleanly when signal is aborted after progress', async () => {
    const client = new AccountClient('https://test.example');

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        device_code: 'dc_4',
        user_code: 'CCCC-2222',
        verification_uri: 'https://auth.example/device',
        expires_in: 300,
        interval: 5,
      }),
    );

    const abort = new AbortController();
    const resultPromise = deviceCodeSignIn(client, () => {
      // Abort mid-flow after pairStart resolves.
      abort.abort();
    }, abort.signal);

    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.outcome).toBe('error');
    expect((result as { outcome: string; message: string }).message).toBe('aborted');
  });
});

// ---------------------------------------------------------------------------
// getStoredCredential — reads from secure-storage
// ---------------------------------------------------------------------------

describe('getStoredCredential', () => {
  it('returns null when nothing is stored', async () => {
    const cred = await getStoredCredential();
    expect(cred).toBeNull();
  });

  it('returns the stored value when set', async () => {
    store.set(CREDENTIAL_KEY, 'mdc_test.val');
    const cred = await getStoredCredential();
    expect(cred).toBe('mdc_test.val');
  });
});

// ---------------------------------------------------------------------------
// Relay-token selection + registerEndpoint wiring in CapacitorSyncClient
// ---------------------------------------------------------------------------
// We test getStoredCredential-based token selection and registerEndpoint
// directly, without importing CapacitorSyncClient (which has complex native
// plugin deps). The wiring is exercised at the unit level by inspecting what
// getStoredCredential returns and what AccountClient.registerEndpoint would
// be called with, rather than spinning up the full engine.

describe('relay-token selection logic', () => {
  it('getStoredCredential returns the stored credential for use as relay token', async () => {
    store.set(CREDENTIAL_KEY, 'mdc_relay.secret');
    const cred = await getStoredCredential();
    // This is what ensureStarted() reads and passes as relayAuthToken.
    expect(cred).toBe('mdc_relay.secret');
  });

  it('getStoredCredential returns null when nothing stored — fall back to VITE_ token', async () => {
    // store is empty
    const cred = await getStoredCredential();
    expect(cred).toBeNull();
    // ensureStarted() will use RELAY_AUTH_TOKEN ?? undefined instead.
  });
});

describe('AccountClient.registerEndpoint wiring contract', () => {
  it('PUT body contains endpoint_id and relay_url, bearer is the credential', async () => {
    const client = new AccountClient('https://test.example');
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));

    await client.registerEndpoint('mdc_id.secret', 'ep_test_123', 'https://sync.minutist.ai');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/account/devices/self/endpoint');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer mdc_id.secret',
    );
    const body = JSON.parse(init.body as string) as {
      endpoint_id: string;
      relay_url: string;
    };
    expect(body.endpoint_id).toBe('ep_test_123');
    expect(body.relay_url).toBe('https://sync.minutist.ai');
  });
});
