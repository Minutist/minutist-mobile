/**
 * AccountClient — typed HTTP client for the account-service.
 *
 * Base URL defaults to 'https://api.minutist.ai', overridable via
 * VITE_ACCOUNT_SERVICE_URL for dev/test builds.
 */

const ACCOUNT_SERVICE_URL =
  (import.meta.env.VITE_ACCOUNT_SERVICE_URL as string | undefined) ??
  'https://api.minutist.ai';

export interface PairStartResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export type PollStatus =
  | 'authorization_pending'
  | 'slow_down'
  | 'expired_token'
  | 'access_denied'
  | 'authorised';

export interface PairPollResponse {
  status: PollStatus;
  device_credential?: string;
  account_id?: string;
  device_id?: string;
}

export interface DeviceInfo {
  device_id: string;
  label?: string;
  endpoint_id?: string;
  relay_url?: string;
  /** The device's iroh direct addresses ("ip:port"), so a same-tailnet/LAN peer
   *  is dialled directly instead of via the relay. Absent on older records. */
  direct_addrs?: string[];
}

export class AccountClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string = ACCOUNT_SERVICE_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async pairStart(): Promise<PairStartResponse> {
    const res = await fetch(`${this.baseUrl}/pair/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'Minutist phone' }),
    });
    if (!res.ok) throw new Error(`pair/start: HTTP ${res.status}`);
    return res.json() as Promise<PairStartResponse>;
  }

  async pairPoll(deviceCode: string): Promise<PairPollResponse> {
    const res = await fetch(`${this.baseUrl}/pair/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    });
    if (!res.ok) throw new Error(`pair/poll: HTTP ${res.status}`);
    return res.json() as Promise<PairPollResponse>;
  }

  async registerEndpoint(
    credential: string,
    endpointId: string,
    relayUrl: string,
    directAddrs: string[] = [],
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/account/devices/self/endpoint`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify({
        endpoint_id: endpointId,
        relay_url: relayUrl,
        direct_addrs: directAddrs,
      }),
    });
    if (!res.ok) throw new Error(`registerEndpoint: HTTP ${res.status}`);
  }

  async listDevices(credential: string): Promise<DeviceInfo[]> {
    const res = await fetch(`${this.baseUrl}/v1/account/devices`, {
      headers: { Authorization: `Bearer ${credential}` },
    });
    if (!res.ok) throw new Error(`listDevices: HTTP ${res.status}`);
    return res.json() as Promise<DeviceInfo[]>;
  }
}

export const accountClient = new AccountClient();
