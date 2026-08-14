/**
 * Unit tests for src/capture/foregroundService.ts — the platform switch that
 * selects platformForegroundServiceController, and the POST_NOTIFICATIONS
 * permission helper.
 *
 * Verified behaviours:
 * - 'android' selects a controller whose onBeforeStart/onAfterStop call the
 *   native plugin's start/stop exactly once each.
 * - 'ios' selects a controller that resolves onBeforeStart/onAfterStop without
 *   calling the native plugin at all.
 * - 'web' (and any other platform) behaves the same as 'ios': no native calls.
 * - requestNotificationPermission() resolves true when the native call rejects
 *   (platform-independent fallback path), on every platform.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getPlatformMock = vi.hoisted(() => vi.fn());

const nativePlugin = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  requestNotificationPermission: vi.fn().mockResolvedValue({ granted: true }),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: getPlatformMock },
  registerPlugin: vi.fn(() => nativePlugin),
}));

beforeEach(() => {
  vi.resetModules();
  getPlatformMock.mockReset();
  nativePlugin.start.mockReset().mockResolvedValue(undefined);
  nativePlugin.stop.mockReset().mockResolvedValue(undefined);
  nativePlugin.requestNotificationPermission
    .mockReset()
    .mockResolvedValue({ granted: true });
});

describe('platformForegroundServiceController — android', () => {
  it('calls the native plugin start/stop exactly once each', async () => {
    getPlatformMock.mockReturnValue('android');
    const { platformForegroundServiceController } = await import(
      './foregroundService'
    );

    await platformForegroundServiceController.onBeforeStart();
    await platformForegroundServiceController.onAfterStop();

    expect(nativePlugin.start).toHaveBeenCalledTimes(1);
    expect(nativePlugin.stop).toHaveBeenCalledTimes(1);
  });
});

describe('platformForegroundServiceController — ios', () => {
  it('resolves onBeforeStart/onAfterStop without calling the native plugin', async () => {
    getPlatformMock.mockReturnValue('ios');
    const { platformForegroundServiceController } = await import(
      './foregroundService'
    );

    await expect(
      platformForegroundServiceController.onBeforeStart(),
    ).resolves.toBeUndefined();
    await expect(
      platformForegroundServiceController.onAfterStop(),
    ).resolves.toBeUndefined();

    expect(nativePlugin.start).not.toHaveBeenCalled();
    expect(nativePlugin.stop).not.toHaveBeenCalled();
  });
});

describe('platformForegroundServiceController — web', () => {
  it('resolves onBeforeStart/onAfterStop without calling the native plugin', async () => {
    getPlatformMock.mockReturnValue('web');
    const { platformForegroundServiceController } = await import(
      './foregroundService'
    );

    await expect(
      platformForegroundServiceController.onBeforeStart(),
    ).resolves.toBeUndefined();
    await expect(
      platformForegroundServiceController.onAfterStop(),
    ).resolves.toBeUndefined();

    expect(nativePlugin.start).not.toHaveBeenCalled();
    expect(nativePlugin.stop).not.toHaveBeenCalled();
  });
});

describe.each(['android', 'ios', 'web'])(
  'requestNotificationPermission — %s',
  (platform) => {
    it('resolves true when the native call rejects', async () => {
      getPlatformMock.mockReturnValue(platform);
      nativePlugin.requestNotificationPermission.mockRejectedValueOnce(
        new Error('plugin unavailable'),
      );
      const { requestNotificationPermission } = await import(
        './foregroundService'
      );

      await expect(requestNotificationPermission()).resolves.toBe(true);
    });
  },
);
