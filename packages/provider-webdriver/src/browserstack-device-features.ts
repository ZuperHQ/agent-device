import { PROVIDER_DEVICE_ORIENTATIONS } from '@agent-device/contracts/remote';
import { type ProviderFeatureFields } from './providers.ts';
import { rejectConflictingNetworkFields } from './provider-feature-support.ts';
import { projectDeviceFeatures } from './device-feature-projection.ts';
import type { CloudWebDriverPlatform } from './runtime.ts';

/**
 * BrowserStack "device feature" session capabilities.
 *
 * These are vendor capabilities: on the W3C wire they belong inside `bstack:options`, not at the
 * top level. BrowserStack's YAML config lists them unnested and its SDK moves them — agent-device
 * talks to the hub directly, so it nests them here.
 *
 * Which fields BrowserStack accepts at all is declared in `providers.ts`; this
 * table only says which `bstack:options` key a supported field lands on. Adding a capability means
 * adding a spec row, not a branch in the capability builder.
 */
export type BrowserStackDeviceFeatureFields = Pick<
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

type BrowserStackDeviceFeatureSpec = {
  /** `CliFlags`/profile field this capability is configured from. */
  field: keyof BrowserStackDeviceFeatureFields;
  /** Key emitted inside `bstack:options`. */
  capability: string;
  /** Canonical CLI flag, so an error can name a recovery action. */
  flag: string;
  /**
   * `negated-boolean` is a flag whose presence means "turn the capability off" — BrowserStack
   * defaults `resignApp` to true, so the only useful instruction is the opt-out.
   */
  type: 'string' | 'enum' | 'negated-boolean';
  enumValues?: readonly string[];
  /** Platform the capability applies to; absent means both. */
  platform?: CloudWebDriverPlatform;
};

export const BROWSERSTACK_DEVICE_FEATURE_SPECS: readonly BrowserStackDeviceFeatureSpec[] = [
  {
    field: 'providerDeviceOrientation',
    capability: 'deviceOrientation',
    flag: '--provider-device-orientation',
    type: 'enum',
    enumValues: PROVIDER_DEVICE_ORIENTATIONS,
  },
  {
    field: 'providerGeoLocation',
    capability: 'geoLocation',
    flag: '--provider-geo-location',
    type: 'string',
  },
  {
    field: 'providerTimezone',
    capability: 'timezone',
    flag: '--provider-timezone',
    type: 'string',
  },
  {
    // BrowserStack defaults to Appium 1.x when unset; `mobile:` commands the interactor issues
    // (deepLink, pressButton, activateApp) need a 2.x+ server.
    field: 'providerAppiumVersion',
    capability: 'appiumVersion',
    flag: '--provider-appium-version',
    type: 'string',
  },
  {
    field: 'providerLanguage',
    capability: 'language',
    flag: '--provider-language',
    type: 'string',
  },
  {
    field: 'providerLocale',
    capability: 'locale',
    flag: '--provider-locale',
    type: 'string',
  },
  {
    field: 'providerNetworkProfile',
    capability: 'networkProfile',
    flag: '--provider-network-profile',
    type: 'string',
  },
  {
    field: 'providerCustomNetwork',
    capability: 'customNetwork',
    flag: '--provider-custom-network',
    type: 'string',
  },
  {
    // BrowserStack re-signs uploaded iOS apps with its own provisioning profile, which strips
    // entitlements. Opting out keeps entitlement-dependent features (push notifications) testable.
    field: 'providerNoResignApp',
    capability: 'resignApp',
    flag: '--provider-no-resign-app',
    type: 'negated-boolean',
    platform: 'ios',
  },
];

/**
 * Builds the `bstack:options` fragment for the configured device features.
 *
 * Rejects combinations BrowserStack cannot act on unambiguously, so a failure names a flag rather
 * than surfacing as a silently ignored capability on a remote device.
 */
export function buildBrowserStackDeviceFeatureCapabilities(
  fields: BrowserStackDeviceFeatureFields,
  platform: CloudWebDriverPlatform,
): Record<string, unknown> {
  rejectConflictingNetworkFields(fields, 'BrowserStack');
  const capabilities: Record<string, unknown> = {};
  projectDeviceFeatures({
    specs: BROWSERSTACK_DEVICE_FEATURE_SPECS,
    fields,
    platform,
    emit: (spec, value) => {
      capabilities[spec.capability] = spec.type === 'negated-boolean' ? false : value;
    },
  });
  return capabilities;
}
