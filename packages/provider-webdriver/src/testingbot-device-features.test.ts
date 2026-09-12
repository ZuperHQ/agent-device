import { test } from 'vitest';
import assert from 'node:assert/strict';

import { AppError } from '@agent-device/kernel/errors';
import {
  TESTINGBOT_DEVICE_FEATURE_SPECS,
  buildTestingBotDeviceFeatureCapabilities,
} from './testingbot-device-features.ts';

// Every device-feature field TestingBot supports must own a spec row: a field the table forgets
// parses off the CLI, rides the profile, and is then silently dropped before the hub ever sees it.
const TESTINGBOT_DEVICE_FEATURE_FIELDS = [
  'providerDeviceOrientation',
  'providerGeoLocation',
  'providerTimezone',
  'providerAppiumVersion',
  'providerLanguage',
  'providerLocale',
  'providerNetworkProfile',
  'providerCustomNetwork',
  'providerNoResignApp',
] as const;

test('every supported device-feature field maps to a capability spec', () => {
  const fields = TESTINGBOT_DEVICE_FEATURE_SPECS.map((spec) => spec.field);
  assert.deepEqual([...fields].sort(), [...TESTINGBOT_DEVICE_FEATURE_FIELDS].sort());
});

test('device features split across the appium and tb:options namespaces', () => {
  const capabilities = buildTestingBotDeviceFeatureCapabilities(
    {
      providerDeviceOrientation: 'landscape',
      providerGeoLocation: 'DE',
      providerTimezone: 'Europe/Brussels',
      providerAppiumVersion: '3.2.0',
      providerLanguage: 'fr',
      providerLocale: 'fr_CA',
      providerNetworkProfile: '3G',
      providerNoResignApp: true,
    },
    'ios',
  );

  // Appium-standard capabilities stay top-level and keep their `appium:` prefix; only
  // TestingBot-owned ones nest, which is the split the hub actually reads.
  assert.deepEqual(capabilities.appium, {
    // TestingBot documents orientation in upper case.
    'appium:orientation': 'LANDSCAPE',
    'appium:language': 'fr',
    'appium:locale': 'fr_CA',
  });
  assert.deepEqual(capabilities.testingBot, {
    timeZone: 'Europe/Brussels',
    // TestingBot pins the hosted Appium server from `tb:options`, not a top-level capability.
    appiumVersion: '3.2.0',
    'testingbot.geoCountryCode': 'DE',
    throttle_network: '3G',
    // The flag is the opt-out, so its presence has to invert into an explicit false.
    resigningEnabled: false,
  });
});

test('unset device features emit no capability keys', () => {
  assert.deepEqual(buildTestingBotDeviceFeatureCapabilities({}, 'android'), {
    appium: {},
    testingBot: {},
  });
});

test('a custom network shape is parsed into TestingBot throttling fields', () => {
  const capabilities = buildTestingBotDeviceFeatureCapabilities(
    {
      providerCustomNetwork: '{"downloadSpeed":10240,"uploadSpeed":5120,"latency":100,"loss":0}',
    },
    'android',
  );

  assert.deepEqual(capabilities.testingBot, {
    throttle_network: { downloadSpeed: 10240, uploadSpeed: 5120, latency: 100, loss: 0 },
  });
});

test('an unparseable custom network shape is rejected at the flag boundary, not sent to the hub', () => {
  assert.throws(
    () => buildTestingBotDeviceFeatureCapabilities({ providerCustomNetwork: '1000' }, 'android'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.match(String(error.details?.hint), /downloadSpeed/);
      return true;
    },
  );
});

test('app re-signing opt-out is rejected on Android with a recovery hint', () => {
  assert.throws(
    () => buildTestingBotDeviceFeatureCapabilities({ providerNoResignApp: true }, 'android'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.match(error.message, /--provider-no-resign-app applies to ios sessions only/);
      assert.match(String(error.details?.hint), /--platform ios/);
      return true;
    },
  );
});

test('a named network profile and a custom network shape cannot both be configured', () => {
  assert.throws(
    () =>
      buildTestingBotDeviceFeatureCapabilities(
        { providerNetworkProfile: '3G', providerCustomNetwork: '{"latency":0}' },
        'android',
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.match(error.message, /TestingBot accepts either/);
      return true;
    },
  );
});
