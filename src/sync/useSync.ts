/**
 * React context + hook that exposes the active `SyncClient` to all views.
 *
 * Defaults to the `mockSyncClient` so views work without any native plugin.
 * Swap the provider value with the real plugin bridge once the iroh-blobs FFI
 * spike lands (see planning issue 0016).
 */

import { createContext, useContext } from 'react';
import type { SyncClient } from './index';
import { mockSyncClient } from './mock';

export const SyncContext = createContext<SyncClient>(mockSyncClient);

/**
 * Return the active `SyncClient`.  Must be called inside a component tree
 * wrapped by `SyncContext.Provider`; if no provider is present it falls back
 * to the mock (the context default).
 */
export function useSync(): SyncClient {
  return useContext(SyncContext);
}
