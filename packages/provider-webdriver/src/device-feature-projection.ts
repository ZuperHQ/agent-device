import { requireFeaturePlatform } from './provider-feature-support.ts';
import type { CloudWebDriverPlatform } from './runtime.ts';

/**
 * The shared walk over a provider's device-feature spec table.
 *
 * Every provider answers the same three questions in the same order — is this field configured,
 * does it apply to this platform, and what value does the capability take — and differs only in
 * where the resulting key lands and what the value becomes. Those two answers are the callback;
 * the order, the skip rule, and the platform check are here so a provider cannot quietly acquire
 * its own.
 */
export type DeviceFeatureSpecShape<TField extends string> = {
  field: TField;
  capability: string;
  flag: string;
  /** Platform the capability applies to; absent means both. */
  platform?: CloudWebDriverPlatform;
};

export function projectDeviceFeatures<
  TField extends string,
  TSpec extends DeviceFeatureSpecShape<TField>,
>(options: {
  specs: readonly TSpec[];
  fields: Partial<Record<TField, string | boolean>>;
  platform: CloudWebDriverPlatform;
  /** Places one supported capability; the provider decides the namespace and the value. */
  emit: (spec: TSpec, value: string | boolean) => void;
}): void {
  for (const spec of options.specs) {
    const value = options.fields[spec.field];
    if (value === undefined || value === false || value === '') continue;
    if (spec.platform) {
      requireFeaturePlatform({
        flag: spec.flag,
        capability: spec.capability,
        supported: spec.platform,
        platform: options.platform,
      });
    }
    options.emit(spec, value);
  }
}
