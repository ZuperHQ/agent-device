import { AppError } from '@agent-device/kernel/errors';
import { type ProviderFeatureFields } from './providers.ts';
import { rejectConflictingNetworkFields } from './provider-feature-support.ts';
import { projectDeviceFeatures } from './device-feature-projection.ts';
import type { CloudWebDriverPlatform } from './runtime.ts';

/**
 * TestingBot session capabilities configured from `--provider-*` flags.
 *
 * TestingBot splits them across two namespaces on the W3C wire: the Appium-standard ones
 * (orientation, locale, language) stay top-level with the `appium:` prefix, while the
 * TestingBot-owned ones (time zone, geolocation proxy, network throttling, re-signing) nest inside
 * `tb:options`. The table is the contract; `namespace` is what decides where a key lands.
 */
export type TestingBotDeviceFeatureFields = Pick<
  ProviderFeatureFields,
  | 'providerDeviceOrientation'
  | 'providerGeoLocation'
  | 'providerTimezone'
  | 'providerAppiumVersion'
  | 'providerLanguage'
  | 'providerLocale'
  | 'providerNetworkProfile'
  | 'providerCustomNetwork'
  | 'providerNoResignApp'
>;

export type TestingBotDeviceFeatureCapabilities = {
  /** Top-level `appium:`-prefixed capabilities. */
  appium: Record<string, unknown>;
  /** Vendor capabilities nested inside `tb:options`. */
  testingBot: Record<string, unknown>;
};

type TestingBotDeviceFeatureSpec = {
  field: keyof TestingBotDeviceFeatureFields;
  /** Capability key, already namespace-qualified for `appium`. */
  capability: string;
  namespace: 'appium' | 'tb:options';
  flag: string;
  /**
   * `uppercase` matches TestingBot's documented orientation values (PORTRAIT/LANDSCAPE).
   * `negated-boolean` is a flag whose presence turns the capability off: TestingBot re-signs iOS
   * apps by default, so the only useful instruction is the opt-out.
   * `network` is a preset string or a JSON throttling shape.
   */
  type: 'string' | 'uppercase' | 'negated-boolean' | 'network';
  platform?: CloudWebDriverPlatform;
};

export const TESTINGBOT_DEVICE_FEATURE_SPECS: readonly TestingBotDeviceFeatureSpec[] = [
  {
    field: 'providerDeviceOrientation',
    capability: 'appium:orientation',
    namespace: 'appium',
    flag: '--provider-device-orientation',
    type: 'uppercase',
  },
  {
    field: 'providerLanguage',
    capability: 'appium:language',
    namespace: 'appium',
    flag: '--provider-language',
    type: 'string',
  },
  {
    field: 'providerLocale',
    capability: 'appium:locale',
    namespace: 'appium',
    flag: '--provider-locale',
    type: 'string',
  },
  {
    field: 'providerTimezone',
    capability: 'timeZone',
    namespace: 'tb:options',
    flag: '--provider-timezone',
    type: 'string',
  },
  {
    field: 'providerAppiumVersion',
    capability: 'appiumVersion',
    namespace: 'tb:options',
    flag: '--provider-appium-version',
    type: 'string',
  },
  {
    // TestingBot routes session traffic through a proxy in the requested country.
    field: 'providerGeoLocation',
    capability: 'testingbot.geoCountryCode',
    namespace: 'tb:options',
    flag: '--provider-geo-location',
    type: 'string',
  },
  {
    field: 'providerNetworkProfile',
    capability: 'throttle_network',
    namespace: 'tb:options',
    flag: '--provider-network-profile',
    type: 'string',
  },
  {
    field: 'providerCustomNetwork',
    capability: 'throttle_network',
    namespace: 'tb:options',
    flag: '--provider-custom-network',
    type: 'network',
  },
  {
    // TestingBot re-signs uploaded iOS apps so development builds install on its devices, which
    // strips entitlements. Opting out keeps entitlement-dependent features testable.
    field: 'providerNoResignApp',
    capability: 'resigningEnabled',
    namespace: 'tb:options',
    flag: '--provider-no-resign-app',
    type: 'negated-boolean',
    platform: 'ios',
  },
];

/**
 * Projects the configured device features onto their TestingBot capability namespaces.
 *
 * Rejects combinations TestingBot cannot act on unambiguously, so a failure names a flag rather
 * than surfacing as a silently ignored capability on a remote device.
 */
export function buildTestingBotDeviceFeatureCapabilities(
  fields: TestingBotDeviceFeatureFields,
  platform: CloudWebDriverPlatform,
): TestingBotDeviceFeatureCapabilities {
  rejectConflictingNetworkFields(fields, 'TestingBot');
  const capabilities: TestingBotDeviceFeatureCapabilities = { appium: {}, testingBot: {} };
  projectDeviceFeatures({
    specs: TESTINGBOT_DEVICE_FEATURE_SPECS,
    fields,
    platform,
    emit: (spec, value) => {
      const target = spec.namespace === 'appium' ? capabilities.appium : capabilities.testingBot;
      target[spec.capability] = featureCapabilityValue(spec, value);
    },
  });
  return capabilities;
}

function featureCapabilityValue(
  spec: TestingBotDeviceFeatureSpec,
  value: string | boolean,
): unknown {
  if (spec.type === 'negated-boolean') return false;
  const text = String(value);
  if (spec.type === 'uppercase') return text.toUpperCase();
  if (spec.type === 'network') return parseCustomNetworkShape(spec, text);
  return text;
}

/**
 * TestingBot's custom throttling shape is an object, not a scalar, so the JSON is parsed and
 * validated here rather than forwarded — the hub accepts an unusable value and then ignores it.
 */
function parseCustomNetworkShape(
  spec: TestingBotDeviceFeatureSpec,
  value: string,
): Record<string, number> {
  const parsed = parseJsonObject(value);
  const shape: Record<string, number> = {};
  for (const key of ['downloadSpeed', 'uploadSpeed', 'latency', 'loss'] as const) {
    const entry = parsed?.[key];
    if (entry === undefined) continue;
    const numeric = typeof entry === 'number' ? entry : Number(entry);
    if (!Number.isFinite(numeric) || numeric < 0) break;
    shape[key] = numeric;
  }
  if (!parsed || Object.keys(shape).length === 0) {
    throw new AppError('INVALID_ARGS', `Invalid ${spec.flag} value: ${value}.`, {
      hint: 'Pass a JSON object such as {"downloadSpeed":10240,"uploadSpeed":10240,"latency":0,"loss":0}, or use --provider-network-profile for a named preset.',
      flag: spec.flag,
      capability: spec.capability,
    });
  }
  return shape;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
