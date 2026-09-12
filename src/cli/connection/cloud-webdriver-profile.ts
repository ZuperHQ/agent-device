import {
  CLOUD_WEBDRIVER_PROVIDERS,
  readAwsDeviceFarmRegionFromArn,
  type CloudWebDriverKnownProviderName,
} from '@agent-device/provider-webdriver';
import { rejectUnsupportedProviderFeatures } from '@agent-device/provider-webdriver/provider-feature-support';
import type { RemoteConfigProfile } from '../../remote/remote-config-schema.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { PlatformSelector } from '@agent-device/kernel/device';
import type { CliFlags } from '@agent-device/contracts/command';
import fs from 'node:fs';
import path from 'node:path';
import { type EnvMap } from '@agent-device/kernel/source-value';
import { readCloudDeviceFeatureProfileFields, readMetroProfileFields } from './profile-fields.ts';
import { persistAndResolveGeneratedProfile } from './generated-config.ts';
import { resolveRequestedLeaseBackend } from '../commands/connection-runtime.ts';
import { buildConnectClientId } from './client-id.ts';

export function resolveCloudWebDriverConnectProfile(options: {
  provider: CloudWebDriverKnownProviderName;
  flags: CliFlags;
  stateDir: string;
  cwd: string;
  env?: EnvMap;
}): { flags: CliFlags; remoteConfigPath: string } {
  const providerConfig = requireConnectProfileBuilder(options.provider)(options);
  const clientId = buildConnectClientId(
    options.provider,
    options.stateDir,
    options.flags.session,
    providerConfig.device,
  );
  const profile: RemoteConfigProfile = {
    tenant: options.flags.tenant ?? options.provider,
    sessionIsolation: options.flags.sessionIsolation ?? 'tenant',
    runId: options.flags.runId ?? `${options.provider}-${clientId}`,
    leaseProvider: options.provider,
    clientId,
    leaseBackend: options.flags.leaseBackend ?? resolveRequestedLeaseBackend(options.flags),
    target: options.flags.target ?? 'mobile',
    session: options.flags.session,
    ...providerConfig,
    ...readMetroProfileFields(options.flags),
  };
  return persistAndResolveGeneratedProfile({
    stateDir: options.stateDir,
    provider: options.provider,
    profile,
    cwd: options.cwd,
    env: options.env,
    flags: options.flags,
  });
}

type ConnectProfileBuilder = (options: {
  flags: CliFlags;
  env?: EnvMap;
  cwd: string;
}) => RemoteConfigProfile;

const CLOUD_WEBDRIVER_CONNECT_PROFILE_BUILDERS: readonly {
  provider: CloudWebDriverKnownProviderName;
  buildProfileFields: ConnectProfileBuilder;
}[] = [
  {
    provider: CLOUD_WEBDRIVER_PROVIDERS.browserStack,
    buildProfileFields: browserStackProfileFields,
  },
  {
    provider: CLOUD_WEBDRIVER_PROVIDERS.testingBot,
    buildProfileFields: testingBotProfileFields,
  },
  {
    provider: CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
    buildProfileFields: awsDeviceFarmProfileFields,
  },
];

function requireConnectProfileBuilder(
  provider: CloudWebDriverKnownProviderName,
): ConnectProfileBuilder {
  const builder = CLOUD_WEBDRIVER_CONNECT_PROFILE_BUILDERS.find(
    (entry) => entry.provider === provider,
  )?.buildProfileFields;
  if (builder) return builder;
  throw new AppError('INVALID_ARGS', `Unsupported cloud WebDriver provider "${provider}".`);
}

function testingBotProfileFields(options: {
  flags: CliFlags;
  env?: EnvMap;
  cwd: string;
}): RemoteConfigProfile {
  rejectUnsupportedProviderFeatures(options.flags, CLOUD_WEBDRIVER_PROVIDERS.testingBot);
  requireTestingBotCredential(options.env, ['TESTINGBOT_KEY', 'TB_KEY']);
  requireTestingBotCredential(options.env, ['TESTINGBOT_SECRET', 'TB_SECRET']);
  const platform = requireCloudWebDriverPlatform(
    options.flags.platform,
    'connect testingbot requires --platform ios|android.',
  );
  return {
    platform,
    device: requireFlag(
      options.flags.device,
      'connect testingbot requires --device <name-or-regex>.',
    ),
    providerOsVersion: requireFlag(
      options.flags.providerOsVersion,
      'connect testingbot requires --provider-os-version <version-or-regex>.',
    ),
    providerApp: normalizeProviderAppReference(
      requireFlag(
        options.flags.providerApp,
        'connect testingbot requires --provider-app <tb://app-key-or-local-path>.',
      ),
      options.cwd,
      { scheme: 'tb://', service: 'TestingBot' },
    ),
    providerBuild: options.flags.providerBuild,
    providerSessionName: options.flags.providerSessionName,
    providerMaxDuration: options.flags.providerMaxDuration,
    providerTabletOnly: options.flags.providerTabletOnly,
    ...readCloudDeviceFeatureProfileFields(options.flags),
  };
}

/** Accepts TestingBot's own `TB_*` names as aliases for the canonical `TESTINGBOT_*` pair. */
function requireTestingBotCredential(env: EnvMap | undefined, names: readonly string[]): string {
  const value = names.map((name) => env?.[name]).find((entry): entry is string => Boolean(entry));
  if (value) return value;
  throw new AppError('INVALID_ARGS', `connect testingbot requires ${names[0]} in the environment.`);
}

function browserStackProfileFields(options: {
  flags: CliFlags;
  env?: EnvMap;
  cwd: string;
}): RemoteConfigProfile {
  rejectUnsupportedProviderFeatures(options.flags, CLOUD_WEBDRIVER_PROVIDERS.browserStack);
  requireEnv(options.env, 'BROWSERSTACK_USERNAME', 'connect browserstack');
  requireEnv(options.env, 'BROWSERSTACK_ACCESS_KEY', 'connect browserstack');
  const platform = requireCloudWebDriverPlatform(
    options.flags.platform,
    'connect browserstack requires --platform ios|android.',
  );
  const device = requireFlag(
    options.flags.device,
    'connect browserstack requires --device <name>.',
  );
  const providerOsVersion = requireFlag(
    options.flags.providerOsVersion,
    'connect browserstack requires --provider-os-version <version>.',
  );
  const providerApp = normalizeBrowserStackAppReference(
    requireFlag(
      options.flags.providerApp,
      'connect browserstack requires --provider-app <bs://app-id-or-local-path>.',
    ),
    options.cwd,
  );
  return {
    platform,
    device,
    providerOsVersion,
    providerApp,
    providerProject: options.flags.providerProject,
    providerBuild: options.flags.providerBuild,
    providerSessionName: options.flags.providerSessionName,
    ...readCloudDeviceFeatureProfileFields(options.flags),
  };
}

function normalizeBrowserStackAppReference(app: string, cwd: string): string {
  return normalizeProviderAppReference(app, cwd, { scheme: 'bs://', service: 'BrowserStack' });
}

/**
 * A provider app reference is its own storage scheme, a public URL, or a local file.
 *
 * The local path is resolved and proven to exist here so `connect` fails on a mistyped path rather
 * than at session creation, when a device may already be allocated.
 */
function normalizeProviderAppReference(
  app: string,
  cwd: string,
  provider: { scheme: string; service: string },
): string {
  if (app.startsWith(provider.scheme) || /^https?:\/\//i.test(app)) return app;
  const resolvedPath = path.resolve(cwd, app);
  try {
    if (fs.statSync(resolvedPath).isFile()) return resolvedPath;
  } catch {
    // Report one stable profile error below.
  }
  throw new AppError('INVALID_ARGS', `${provider.service} app file not found: ${resolvedPath}`);
}

function awsDeviceFarmProfileFields(options: {
  flags: CliFlags;
  env?: EnvMap;
}): RemoteConfigProfile {
  const { env, flags } = options;
  rejectUnsupportedProviderFeatures(flags, CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm);
  const platform = requireCloudWebDriverPlatform(
    flags.platform,
    'connect aws-device-farm requires --platform ios|android.',
  );
  const awsProjectArn = requireAwsProfileValue(
    flags.awsProjectArn,
    env,
    ['AGENT_DEVICE_AWS_DEVICE_FARM_PROJECT_ARN', 'AWS_DEVICE_FARM_PROJECT_ARN'],
    'connect aws-device-farm requires --aws-project-arn <arn> or AWS_DEVICE_FARM_PROJECT_ARN.',
  );
  return {
    platform,
    device: flags.device,
    awsProjectArn,
    awsDeviceArn: requireAwsProfileValue(
      flags.awsDeviceArn,
      env,
      ['AGENT_DEVICE_AWS_DEVICE_FARM_DEVICE_ARN', 'AWS_DEVICE_FARM_DEVICE_ARN'],
      'connect aws-device-farm requires --aws-device-arn <arn> or AWS_DEVICE_FARM_DEVICE_ARN.',
    ),
    awsAppArn: readAwsProfileValue(flags.awsAppArn, env, [
      'AGENT_DEVICE_AWS_DEVICE_FARM_APP_ARN',
      'AWS_DEVICE_FARM_APP_ARN',
    ]),
    awsRegion:
      readAwsProfileValue(flags.awsRegion, env, ['AWS_REGION', 'AWS_DEFAULT_REGION']) ??
      readAwsDeviceFarmRegionFromArn(awsProjectArn),
    awsInteractionMode: flags.awsInteractionMode,
    providerSessionName: flags.providerSessionName,
  };
}

function requireCloudWebDriverPlatform(
  platform: PlatformSelector | undefined,
  message: string,
): 'android' | 'ios' {
  if (platform === 'android' || platform === 'ios') return platform;
  throw new AppError('INVALID_ARGS', message);
}

function requireFlag(value: string | undefined, message: string): string {
  if (value) return value;
  throw new AppError('INVALID_ARGS', message);
}

function requireEnv(env: EnvMap | undefined, name: string, command: string): string {
  const value = env?.[name];
  if (value) return value;
  throw new AppError('INVALID_ARGS', `${command} requires ${name} in the environment.`);
}

function requireAwsProfileValue(
  flagValue: string | undefined,
  env: EnvMap | undefined,
  envNames: readonly string[],
  message: string,
): string {
  return requireFlag(readAwsProfileValue(flagValue, env, envNames), message);
}

function readAwsProfileValue(
  flagValue: string | undefined,
  env: EnvMap | undefined,
  envNames: readonly string[],
): string | undefined {
  if (flagValue) return flagValue;
  return envNames.map((name) => env?.[name]).find((value): value is string => Boolean(value));
}
