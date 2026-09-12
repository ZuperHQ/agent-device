import { test } from 'vitest';
import assert from 'node:assert/strict';

import { AppError } from '@agent-device/kernel/errors';
import { CLOUD_WEBDRIVER_PROVIDERS, providerSupportsFeature } from './providers.ts';
import {
  readProviderFeatureFields,
  rejectUnsupportedProviderFeatures,
} from './provider-feature-support.ts';

const DEVICE_FEATURE_FIELDS = [
  'providerDeviceOrientation',
  'providerGeoLocation',
  'providerTimezone',
  'providerLanguage',
  'providerLocale',
  'providerNetworkProfile',
  'providerCustomNetwork',
  'providerNoResignApp',
] as const;

test('BrowserStack accepts every device-feature flag and AWS Device Farm accepts none', () => {
  for (const field of DEVICE_FEATURE_FIELDS) {
    assert.equal(providerSupportsFeature(CLOUD_WEBDRIVER_PROVIDERS.browserStack, field), true);
    assert.equal(providerSupportsFeature(CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm, field), false);
  }
});

test('a supported flag passes the rejection unchanged', () => {
  assert.doesNotThrow(() =>
    rejectUnsupportedProviderFeatures(
      { providerTimezone: 'Europe/Brussels' },
      CLOUD_WEBDRIVER_PROVIDERS.browserStack,
    ),
  );
});

test('an unsupported flag names every offending flag and a provider that accepts them all', () => {
  assert.throws(
    () =>
      rejectUnsupportedProviderFeatures(
        { providerDeviceOrientation: 'portrait', providerTimezone: 'New_York' },
        CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.match(
        error.message,
        /--provider-device-orientation, --provider-timezone are not supported by aws-device-farm/,
      );
      // The hint names a provider that accepts the whole set, so it stays correct as providers
      // are added rather than pinning one vendor's name into the message.
      assert.match(String(error.details?.hint), /browserstack/);
      assert.deepEqual(error.details?.flags, [
        '--provider-device-orientation',
        '--provider-timezone',
      ]);
      return true;
    },
  );
});

test('an unset or false flag is not treated as configured', () => {
  assert.doesNotThrow(() =>
    rejectUnsupportedProviderFeatures(
      { providerTimezone: '', providerNoResignApp: undefined },
      CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
    ),
  );
});

test('feature fields are read off an untyped daemon request flag bag', () => {
  const fields = readProviderFeatureFields({
    providerDeviceOrientation: 'landscape',
    providerTimezone: 'New_York',
    providerNoResignApp: true,
    unrelatedFlag: 'ignored',
  });

  assert.deepEqual(fields, {
    providerDeviceOrientation: 'landscape',
    providerTimezone: 'New_York',
    providerNoResignApp: true,
  });
});

test('an unrecognized orientation is rejected at the flag boundary, not forwarded to the hub', () => {
  assert.throws(
    () => readProviderFeatureFields({ providerDeviceOrientation: 'landscape-left' }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.match(String(error.details?.hint), /portrait\|landscape/);
      return true;
    },
  );
});

test('empty and wrongly-typed flag values are treated as unset', () => {
  assert.deepEqual(
    readProviderFeatureFields({
      providerTimezone: '',
      providerGeoLocation: 42,
      providerNoResignApp: 'yes',
    }),
    {},
  );
});
