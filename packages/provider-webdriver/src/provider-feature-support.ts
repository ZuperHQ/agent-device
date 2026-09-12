import { PROVIDER_DEVICE_ORIENTATIONS } from '@agent-device/contracts/remote';
import { AppError } from '@agent-device/kernel/errors';
import {
  PROVIDER_FEATURE_SPECS,
  providerSupportsFeature,
  providersSupportingFeatures,
  type CloudWebDriverKnownProviderName,
  type ProviderFeatureField,
  type ProviderFeatureFields,
} from './providers.ts';

/**
 * Validation for the `--provider-*` device-feature flags, driven by the support table in
 * `providers.ts`.
 *
 * Split from the table itself because `providers.ts` is a published entry surface that must stay
 * a leaf module: raising an `AppError` would pull the kernel error graph into every consumer that
 * only wanted the provider vocabulary.
 */

type ProviderFeatureSpec = (typeof PROVIDER_FEATURE_SPECS)[number];

/**
 * Fails when a provider was given `--provider-*` capabilities it cannot act on.
 *
 * Called from both the CLI profile builder and the provider's own session preparation. The second
 * is the one that actually closes the hole: the typed client and hand-authored remote-config
 * profiles reach session preparation without passing through `connect`, so a CLI-only check leaves
 * those routes accepting the capabilities and dropping them.
 */
export function rejectUnsupportedProviderFeatures(
  flags: Record<string, unknown> | undefined,
  provider: CloudWebDriverKnownProviderName,
): void {
  const unsupported = PROVIDER_FEATURE_SPECS.filter(
    (spec) => isConfigured(flags?.[spec.field]) && !providerSupportsFeature(provider, spec.field),
  );
  if (unsupported.length === 0) return;
  const flagList = unsupported.map((spec) => spec.flag);
  const plural = flagList.length !== 1;
  throw new AppError(
    'INVALID_ARGS',
    `${flagList.join(', ')} ${plural ? 'are' : 'is'} not supported by ${provider}.`,
    { hint: recoveryHint(unsupported, plural), provider, flags: flagList },
  );
}

/**
 * Reads provider-feature fields off an untyped flag bag (a daemon request), so the daemon-side
 * capability build and the CLI-side profile build stay driven by the same table.
 *
 * This is a trust boundary: enum values are validated here rather than forwarded to the hub, where
 * an unrecognized value is accepted and then ignored.
 */
export function readProviderFeatureFields(
  flags: Record<string, unknown> | undefined,
): ProviderFeatureFields {
  const fields: Record<string, unknown> = {};
  for (const spec of PROVIDER_FEATURE_SPECS) {
    const value = readFeatureValue(spec, flags?.[spec.field]);
    if (value !== undefined) fields[spec.field] = value;
  }
  return fields as ProviderFeatureFields;
}

/** Both network shapes at once has no unambiguous meaning on any provider that accepts either. */
export function rejectConflictingNetworkFields(
  fields: ProviderFeatureFields,
  providerLabel: string,
): void {
  if (!fields.providerNetworkProfile || !fields.providerCustomNetwork) return;
  throw new AppError(
    'INVALID_ARGS',
    `${providerLabel} accepts either a named network profile or a custom network shape, not both.`,
    {
      hint: 'Pass only one of --provider-network-profile or --provider-custom-network.',
      networkProfile: fields.providerNetworkProfile,
      customNetwork: fields.providerCustomNetwork,
    },
  );
}

/** Fails when a capability applies to one platform only and the session runs on the other. */
export function requireFeaturePlatform(options: {
  flag: string;
  capability: string;
  supported: 'android' | 'ios';
  platform: 'android' | 'ios';
}): void {
  if (options.supported === options.platform) return;
  throw new AppError(
    'INVALID_ARGS',
    `${options.flag} applies to ${options.supported} sessions only, but the session platform is ${options.platform}.`,
    {
      hint: `Drop ${options.flag} or connect with --platform ${options.supported}.`,
      flag: options.flag,
      capability: options.capability,
      platform: options.platform,
    },
  );
}

function recoveryHint(unsupported: readonly ProviderFeatureSpec[], plural: boolean): string {
  const subject = plural ? 'those flags' : 'the flag';
  const providers = providersSupportingFeatures(
    unsupported.map((spec) => spec.field as ProviderFeatureField),
  );
  return providers.length > 0
    ? `Drop ${subject} or connect with ${providers.join(' or ')}.`
    : `Drop ${subject}.`;
}

function isConfigured(value: unknown): boolean {
  return value !== undefined && value !== false && value !== '';
}

function readFeatureValue(spec: ProviderFeatureSpec, value: unknown): unknown {
  if (spec.kind === 'boolean') return value === true ? true : undefined;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return spec.kind === 'orientation' ? requireDeviceOrientation(spec, value) : value;
}

function requireDeviceOrientation(
  spec: ProviderFeatureSpec,
  value: string,
): (typeof PROVIDER_DEVICE_ORIENTATIONS)[number] {
  const match = PROVIDER_DEVICE_ORIENTATIONS.find((orientation) => orientation === value);
  if (match) return match;
  throw new AppError('INVALID_ARGS', `Invalid ${spec.flag} value: ${value}.`, {
    hint: `Use ${PROVIDER_DEVICE_ORIENTATIONS.join('|')}.`,
    flag: spec.flag,
  });
}
