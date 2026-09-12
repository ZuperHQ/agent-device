import { test } from 'vitest';
import assert from 'node:assert/strict';

import { AppError } from '@agent-device/kernel/errors';
import { CLOUD_WEBDRIVER_PROVIDERS, providerSupportsFeature } from './providers.ts';
import {
  readProviderFeatureFields,
  rejectUnsupportedProviderFeatures,
} from './provider-feature-support.ts';

test('TestingBot accepts every device-feature flag BrowserStack accepts', () => {
  for (const field of [
    'providerDeviceOrientation',
    'providerGeoLocation',
    'providerTimezone',
    'providerLanguage',
    'providerLocale',
    'providerNetworkProfile',
    'providerCustomNetwork',
    'providerNoResignApp',
  ] as const) {
    assert.equal(providerSupportsFeature(CLOUD_WEBDRIVER_PROVIDERS.browserStack, field), true);
    assert.equal(providerSupportsFeature(CLOUD_WEBDRIVER_PROVIDERS.testingBot, field), true);
    assert.equal(providerSupportsFeature(CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm, field), false);
  }
});

test('the TestingBot-only session flags are rejected for the other providers', () => {
  for (const field of ['providerMaxDuration', 'providerTabletOnly'] as const) {
    assert.equal(providerSupportsFeature(CLOUD_WEBDRIVER_PROVIDERS.testingBot, field), true);
    assert.equal(providerSupportsFeature(CLOUD_WEBDRIVER_PROVIDERS.browserStack, field), false);
    assert.equal(providerSupportsFeature(CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm, field), false);
  }
});

test('a supported flag passes the rejection unchanged', () => {
  assert.doesNotThrow(() =>
    rejectUnsupportedProviderFeatures(
      { providerTimezone: 'Europe/Brussels', providerTabletOnly: true },
      CLOUD_WEBDRIVER_PROVIDERS.testingBot,
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
      // Both providers accept BOTH flags, so both are offered as a recovery.
      assert.match(String(error.details?.hint), /browserstack/);
      assert.match(String(error.details?.hint), /testingbot/);
      return true;
    },
  );
});

test('the recovery hint offers only providers that accept every rejected flag', () => {
  assert.throws(
    () =>
      rejectUnsupportedProviderFeatures(
        { providerTimezone: 'New_York', providerTabletOnly: true },
        CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      // BrowserStack takes the timezone but not --provider-tablet-only, so naming it would send
      // the caller to a connect that fails on the second flag.
      assert.doesNotMatch(String(error.details?.hint), /browserstack/);
      assert.match(String(error.details?.hint), /testingbot/);
      return true;
    },
  );
});

test('an unset or false flag is not treated as configured', () => {
  assert.doesNotThrow(() =>
    rejectUnsupportedProviderFeatures(
      { providerTimezone: '', providerTabletOnly: false, providerNoResignApp: undefined },
      CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
    ),
  );
});

test('feature fields are read off an untyped daemon request flag bag', () => {
  const fields = readProviderFeatureFields({
    providerDeviceOrientation: 'landscape',
    providerTimezone: 'New_York',
    providerNoResignApp: true,
    providerMaxDuration: '7200',
    providerTabletOnly: true,
    unrelatedFlag: 'ignored',
  });

  assert.deepEqual(fields, {
    providerDeviceOrientation: 'landscape',
    providerTimezone: 'New_York',
    providerNoResignApp: true,
    providerMaxDuration: '7200',
    providerTabletOnly: true,
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
      providerTabletOnly: 'true',
    }),
    {},
  );
});
