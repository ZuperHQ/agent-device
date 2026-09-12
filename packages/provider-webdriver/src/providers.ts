import type { CloudProviderProfileFields } from '@agent-device/contracts/remote';
import type { CloudWebDriverCapabilityOverrides } from './capabilities.ts';

/**
 * The cloud WebDriver provider vocabulary, and everything static that is keyed by it.
 *
 * Endpoints, capability overrides and the device-feature support table live here rather than in
 * each adapter because composing the provider registry needs all of them at construction while
 * needing none of the adapters: the modules that actually talk to a provider load on the request
 * path (ADR 0019). Keeping the static half in one provider-keyed module is what lets the runtime
 * factories stay metadata-eager and implementation-lazy.
 *
 * This is a published entry surface (`@agent-device/provider-webdriver/providers`) and evaluates
 * nothing: every import above is type-only, so a consumer that needs the vocabulary does not pay
 * for the contracts or kernel graph. Validation that has to raise lives in
 * `provider-feature-support.ts`, one module further in, for exactly that reason.
 */

export const CLOUD_WEBDRIVER_PROVIDERS = {
  browserStack: 'browserstack',
  awsDeviceFarm: 'aws-device-farm',
} as const;

export type CloudWebDriverKnownProviderName =
  (typeof CLOUD_WEBDRIVER_PROVIDERS)[keyof typeof CLOUD_WEBDRIVER_PROVIDERS];

const CLOUD_WEBDRIVER_KNOWN_PROVIDERS = new Set<string>(Object.values(CLOUD_WEBDRIVER_PROVIDERS));

export function isCloudWebDriverProviderName(
  provider: string | undefined,
): provider is CloudWebDriverKnownProviderName {
  return provider !== undefined && CLOUD_WEBDRIVER_KNOWN_PROVIDERS.has(provider);
}

// --- BrowserStack ------------------------------------------------------------------------------

export const BROWSERSTACK_APP_AUTOMATE_ENDPOINT = 'https://hub-cloud.browserstack.com/wd/hub/';
export const BROWSERSTACK_APP_UPLOAD_ENDPOINT =
  'https://api-cloud.browserstack.com/app-automate/upload';
export const BROWSERSTACK_SESSION_DETAILS_ENDPOINT =
  'https://api-cloud.browserstack.com/app-automate/sessions';

export const BROWSERSTACK_CAPABILITY_OVERRIDES = {
  install: {
    support: 'partial',
    note: 'Local app artifacts are uploaded to BrowserStack App Automate, then installed with Appium.',
  },
  portReverse: {
    support: 'unsupported',
    note: 'Use BrowserStack Local for network tunneling; agent-device port reverse is not available.',
  },
  artifacts: {
    support: 'supported',
    note: 'BrowserStack session details expose provider-hosted video, Appium logs, device logs, and dashboard links.',
  },
} as const satisfies CloudWebDriverCapabilityOverrides;

// --- AWS Device Farm ---------------------------------------------------------------------------

export const AWS_DEVICE_FARM_CAPABILITY_OVERRIDES = {
  install: {
    support: 'unsupported',
    note: 'Pass appArn when creating the remote access session; local artifact upload/install is not implemented.',
  },
  portReverse: {
    support: 'unsupported',
    note: 'AWS Device Farm remote access does not expose agent-device port reverse.',
  },
  artifacts: {
    support: 'supported',
    note: 'AWS Device Farm remote access exposes provider-hosted video, Appium logs, and device logs after session completion.',
  },
} as const satisfies CloudWebDriverCapabilityOverrides;

// --- Device-feature support ---------------------------------------------------------------------

/**
 * The `--provider-*` session capabilities a hosted provider may be configured with, and which
 * provider can act on each one.
 *
 * A provider that cannot act on a capability must reject it rather than accept it: the value
 * otherwise parses off the CLI, rides the generated profile, and is dropped before the hub sees
 * it — the session runs with provider defaults and nothing says why. This table is the contract;
 * the per-provider capability projections (`*-device-features.ts`) only decide which vendor key a
 * supported field lands on.
 */

type ProviderFeatureValueKind = 'string' | 'orientation' | 'boolean';

type ProviderFeatureSpecShape = {
  field: keyof CloudProviderProfileFields;
  /** Canonical CLI flag, so a rejection can name a recovery action. */
  flag: string;
  kind: ProviderFeatureValueKind;
};

export const PROVIDER_FEATURE_SPECS = [
  {
    field: 'providerDeviceOrientation',
    flag: '--provider-device-orientation',
    kind: 'orientation',
  },
  { field: 'providerGeoLocation', flag: '--provider-geo-location', kind: 'string' },
  { field: 'providerTimezone', flag: '--provider-timezone', kind: 'string' },
  { field: 'providerLanguage', flag: '--provider-language', kind: 'string' },
  { field: 'providerLocale', flag: '--provider-locale', kind: 'string' },
  { field: 'providerNetworkProfile', flag: '--provider-network-profile', kind: 'string' },
  { field: 'providerCustomNetwork', flag: '--provider-custom-network', kind: 'string' },
  { field: 'providerNoResignApp', flag: '--provider-no-resign-app', kind: 'boolean' },
] as const satisfies readonly ProviderFeatureSpecShape[];

type ProviderFeatureSpec = (typeof PROVIDER_FEATURE_SPECS)[number];
export type ProviderFeatureField = ProviderFeatureSpec['field'];
export type ProviderFeatureFields = Pick<CloudProviderProfileFields, ProviderFeatureField>;

/**
 * Which fields each provider can act on. Keyed by the provider union, so adding a cloud provider
 * without deciding what it accepts fails to compile instead of silently accepting everything.
 */
const PROVIDER_FEATURE_SUPPORT = {
  [CLOUD_WEBDRIVER_PROVIDERS.browserStack]: [
    'providerDeviceOrientation',
    'providerGeoLocation',
    'providerTimezone',
    'providerLanguage',
    'providerLocale',
    'providerNetworkProfile',
    'providerCustomNetwork',
    'providerNoResignApp',
  ],
  // Remote-access sessions expose no session-creation capabilities of their own.
  [CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm]: [],
} as const satisfies Record<CloudWebDriverKnownProviderName, readonly ProviderFeatureField[]>;

export function providerSupportsFeature(
  provider: CloudWebDriverKnownProviderName,
  field: ProviderFeatureField,
): boolean {
  return (PROVIDER_FEATURE_SUPPORT[provider] as readonly ProviderFeatureField[]).includes(field);
}

/** Providers that accept every one of the given fields, so a hint can name a connect that works. */
export function providersSupportingFeatures(
  fields: readonly ProviderFeatureField[],
): CloudWebDriverKnownProviderName[] {
  return (Object.keys(PROVIDER_FEATURE_SUPPORT) as CloudWebDriverKnownProviderName[]).filter(
    (provider) => fields.every((field) => providerSupportsFeature(provider, field)),
  );
}
