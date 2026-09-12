import fs from 'node:fs';
import path from 'node:path';
import type { CloudArtifactsResult } from '@agent-device/contracts/observability';
import type { LeaseLifecycleContext } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import type { ProviderWebDriverDependencies } from './dependencies.ts';
import {
  createAwsCliDeviceFarmClient,
  createAwsDeviceFarmPrepareSession,
  listAwsDeviceFarmCloudArtifacts,
} from './aws-device-farm.ts';
// Provider vocabulary plus everything static keyed by it: endpoints, capability maps, and the
// device-feature support table. The adapters themselves load on the request path (ADR 0019).
import {
  AWS_DEVICE_FARM_CAPABILITY_OVERRIDES,
  BROWSERSTACK_APP_AUTOMATE_ENDPOINT,
  BROWSERSTACK_APP_UPLOAD_ENDPOINT,
  BROWSERSTACK_CAPABILITY_OVERRIDES,
  CLOUD_WEBDRIVER_PROVIDERS,
  TESTINGBOT_API_ENDPOINT,
  TESTINGBOT_CAPABILITY_OVERRIDES,
  TESTINGBOT_DEFAULT_MAX_DURATION_SECONDS,
  TESTINGBOT_HUB_ENDPOINT,
  type CloudWebDriverKnownProviderName,
  type TestingBotApiOptions,
} from './providers.ts';
import { readAwsDeviceFarmRegionFromArn } from './connection-verification.ts';
import {
  buildCloudWebDriverBaseCapabilities,
  createCloudWebDriverRuntime,
  type CloudWebDriverPlatform,
  type CloudWebDriverRuntime,
} from './runtime.ts';

export type DefaultCloudWebDriverArtifactEnv = {
  BROWSERSTACK_USERNAME?: string;
  BROWSERSTACK_ACCESS_KEY?: string;
  BROWSERSTACK_SESSION_DETAILS_ENDPOINT?: string;
  TESTINGBOT_KEY?: string;
  TESTINGBOT_SECRET?: string;
  TB_KEY?: string;
  TB_SECRET?: string;
  TESTINGBOT_API_ENDPOINT?: string;
  AWS_REGION?: string;
  AWS_DEFAULT_REGION?: string;
};

export type DefaultCloudWebDriverProviderRuntimeEnv = DefaultCloudWebDriverArtifactEnv & {
  BROWSERSTACK_WEBDRIVER_ENDPOINT?: string;
  BROWSERSTACK_APP_UPLOAD_ENDPOINT?: string;
  TESTINGBOT_WEBDRIVER_ENDPOINT?: string;
  AGENT_DEVICE_AWS_DEVICE_FARM_PROJECT_ARN?: string;
  AWS_DEVICE_FARM_PROJECT_ARN?: string;
  AGENT_DEVICE_AWS_DEVICE_FARM_DEVICE_ARN?: string;
  AWS_DEVICE_FARM_DEVICE_ARN?: string;
  AGENT_DEVICE_AWS_DEVICE_FARM_APP_ARN?: string;
  AWS_DEVICE_FARM_APP_ARN?: string;
};

export type CloudWebDriverProviderDefinition = {
  provider: CloudWebDriverKnownProviderName;
  createRuntime: (env: DefaultCloudWebDriverProviderRuntimeEnv) => CloudWebDriverRuntime;
  listArtifactsFromEnv: (
    providerSessionId: string,
    env: DefaultCloudWebDriverArtifactEnv,
  ) => Promise<CloudArtifactsResult | undefined>;
};

export function createCloudWebDriverProviderDefinitions(
  dependencies: ProviderWebDriverDependencies,
): readonly CloudWebDriverProviderDefinition[] {
  return [
    {
      provider: CLOUD_WEBDRIVER_PROVIDERS.browserStack,
      createRuntime: (env) =>
        createCloudWebDriverRuntime({
          clientVersion: dependencies.clientVersion,
          provider: CLOUD_WEBDRIVER_PROVIDERS.browserStack,
          platform: 'android',
          deviceName: 'BrowserStack device',
          endpoint: env.BROWSERSTACK_WEBDRIVER_ENDPOINT ?? BROWSERSTACK_APP_AUTOMATE_ENDPOINT,
          capabilityOverrides: BROWSERSTACK_CAPABILITY_OVERRIDES,
          listArtifacts: async ({ provider, providerSessionId }) => {
            const { listBrowserStackCloudArtifacts } = await import('./browserstack.ts');
            const username = requireEnv(
              env,
              'BROWSERSTACK_USERNAME',
              'BrowserStack artifact lookup',
            );
            const accessKey = requireEnv(
              env,
              'BROWSERSTACK_ACCESS_KEY',
              'BrowserStack artifact lookup',
            );
            return await listBrowserStackCloudArtifacts(provider, providerSessionId, {
              clientVersion: dependencies.clientVersion,
              username,
              accessKey,
              endpoint: env.BROWSERSTACK_SESSION_DETAILS_ENDPOINT,
            });
          },
          prepareSession: async ({ req, lease, base }) => {
            const request = requireRequest(req, 'BrowserStack');
            const { readProviderFeatureFields, rejectUnsupportedProviderFeatures } =
              await import('./provider-feature-support.ts');
            rejectUnsupportedProviderFeatures(
              request.flags,
              CLOUD_WEBDRIVER_PROVIDERS.browserStack,
            );
            const { buildBrowserStackCapabilities, createBrowserStackUploadApp } =
              await import('./browserstack.ts');
            const { buildBrowserStackDeviceFeatureCapabilities } =
              await import('./browserstack-device-features.ts');
            const username = requireEnv(env, 'BROWSERSTACK_USERNAME', 'BrowserStack');
            const accessKey = requireEnv(env, 'BROWSERSTACK_ACCESS_KEY', 'BrowserStack');
            const platform = requireRequestPlatform(request, 'BrowserStack');
            const deviceName = requireFlag(
              request,
              'device',
              'BrowserStack requires --device <name>.',
            );
            const osVersion = requireFlag(
              request,
              'providerOsVersion',
              'BrowserStack requires --provider-os-version <version>.',
            );
            const app = await resolveBrowserStackAppReference({
              clientVersion: dependencies.clientVersion,
              app: requireFlag(
                request,
                'providerApp',
                'BrowserStack requires --provider-app <bs://app-id-or-local-path>.',
              ),
              cwd: request.cwd,
              username,
              accessKey,
              uploadEndpoint: env.BROWSERSTACK_APP_UPLOAD_ENDPOINT,
              // A local IPA/APK upload can run long (130 MB is routine); an
              // upload is not a billed resource, so the request's cancellation
              // may simply abort it — unlike the session creation that follows.
              signal: request.signal,
            });
            return {
              ...base,
              platform,
              deviceName,
              auth: { username, accessKey },
              uploadApp: createBrowserStackUploadApp({
                clientVersion: dependencies.clientVersion,
                username,
                accessKey,
                endpoint: env.BROWSERSTACK_APP_UPLOAD_ENDPOINT ?? BROWSERSTACK_APP_UPLOAD_ENDPOINT,
              }),
              webdriverCapabilities: buildBrowserStackCapabilities({
                deviceName,
                osVersion,
                app,
                projectName: readFlag(request, 'providerProject'),
                buildName: readFlag(request, 'providerBuild') ?? lease.runId,
                sessionName: readFlag(request, 'providerSessionName') ?? lease.leaseId,
                deviceFeatures: buildBrowserStackDeviceFeatureCapabilities(
                  readProviderFeatureFields(request.flags),
                  platform,
                ),
                configured: buildCloudWebDriverBaseCapabilities(platform, deviceName),
              }),
            };
          },
        }),
      listArtifactsFromEnv: async (providerSessionId, env) => {
        const { listBrowserStackCloudArtifacts } = await import('./browserstack.ts');
        const username = requireEnv(env, 'BROWSERSTACK_USERNAME', 'BrowserStack artifact lookup');
        const accessKey = requireEnv(
          env,
          'BROWSERSTACK_ACCESS_KEY',
          'BrowserStack artifact lookup',
        );
        return await listBrowserStackCloudArtifacts(
          CLOUD_WEBDRIVER_PROVIDERS.browserStack,
          providerSessionId,
          {
            clientVersion: dependencies.clientVersion,
            username,
            accessKey,
            endpoint: env.BROWSERSTACK_SESSION_DETAILS_ENDPOINT,
          },
        );
      },
    },
    {
      provider: CLOUD_WEBDRIVER_PROVIDERS.testingBot,
      createRuntime: (env) =>
        createCloudWebDriverRuntime({
          clientVersion: dependencies.clientVersion,
          provider: CLOUD_WEBDRIVER_PROVIDERS.testingBot,
          platform: 'android',
          deviceName: 'TestingBot device',
          endpoint: env.TESTINGBOT_WEBDRIVER_ENDPOINT ?? TESTINGBOT_HUB_ENDPOINT,
          capabilityOverrides: TESTINGBOT_CAPABILITY_OVERRIDES,
          listArtifacts: async ({ provider, providerSessionId }) => {
            const { listTestingBotCloudArtifacts } = await import('./testingbot.ts');
            return await listTestingBotCloudArtifacts(
              provider,
              providerSessionId,
              testingBotApiOptions(dependencies.clientVersion, env, 'TestingBot artifact lookup'),
            );
          },
          prepareSession: async ({ req, lease, base }) => {
            const request = requireRequest(req, 'TestingBot');
            const { readProviderFeatureFields, rejectUnsupportedProviderFeatures } =
              await import('./provider-feature-support.ts');
            rejectUnsupportedProviderFeatures(request.flags, CLOUD_WEBDRIVER_PROVIDERS.testingBot);
            const {
              buildTestingBotCapabilities,
              createTestingBotUploadApp,
              markTestingBotSession,
            } = await import('./testingbot.ts');
            const { buildTestingBotDeviceFeatureCapabilities } =
              await import('./testingbot-device-features.ts');
            const api = testingBotApiOptions(dependencies.clientVersion, env, 'TestingBot');
            const platform = requireRequestPlatform(request, 'TestingBot');
            const deviceName = requireFlag(
              request,
              'device',
              'TestingBot requires --device <name-or-regex>.',
            );
            const osVersion = requireFlag(
              request,
              'providerOsVersion',
              'TestingBot requires --provider-os-version <version-or-regex>.',
            );
            const app = await resolveTestingBotAppReference({
              api,
              app: requireFlag(
                request,
                'providerApp',
                'TestingBot requires --provider-app <tb://app-key-or-local-path>.',
              ),
              cwd: request.cwd,
              platform,
              // A local IPA/APK upload can run long (300 MB is routine); an upload is not a billed
              // resource, so the request's cancellation may simply abort it — unlike the session
              // creation that follows.
              signal: request.signal,
            });
            return {
              ...base,
              platform,
              deviceName,
              uploadApp: createTestingBotUploadApp(api),
              webdriverCapabilities: buildTestingBotCapabilities({
                platform,
                key: api.key,
                secret: api.secret,
                deviceName,
                osVersion,
                app,
                buildName: readFlag(request, 'providerBuild') ?? lease.runId,
                sessionName: readFlag(request, 'providerSessionName') ?? lease.leaseId,
                maxDurationSeconds: readTestingBotMaxDuration(request),
                tabletOnly: request.flags?.providerTabletOnly === true,
                deviceFeatures: buildTestingBotDeviceFeatureCapabilities(
                  readProviderFeatureFields(request.flags),
                  platform,
                ),
                configured: buildCloudWebDriverBaseCapabilities(platform, deviceName),
              }),
              // TestingBot reports an unreported session as "unknown", which hides real failures in
              // its dashboard, so the session state is always stated on release. The id is the one
              // the hub minted, so it is only known once the session exists.
              cleanup: async ({ providerSessionId }) => {
                if (!providerSessionId) return undefined;
                await markTestingBotSession(
                  providerSessionId,
                  { success: true, statusMessage: `agent-device lease ${lease.leaseId} released` },
                  api,
                );
                return undefined;
              },
            };
          },
        }),
      listArtifactsFromEnv: async (providerSessionId, env) => {
        const { listTestingBotCloudArtifacts } = await import('./testingbot.ts');
        return await listTestingBotCloudArtifacts(
          CLOUD_WEBDRIVER_PROVIDERS.testingBot,
          providerSessionId,
          testingBotApiOptions(dependencies.clientVersion, env, 'TestingBot artifact lookup'),
        );
      },
    },
    {
      provider: CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
      createRuntime: (env) =>
        createCloudWebDriverRuntime({
          clientVersion: dependencies.clientVersion,
          provider: CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
          endpoint: 'http://127.0.0.1/',
          platform: 'android',
          deviceName: 'AWS Device Farm device',
          capabilityOverrides: AWS_DEVICE_FARM_CAPABILITY_OVERRIDES,
          listArtifacts: async ({ provider, providerSessionId }) => {
            const client = createAwsCliDeviceFarmClient({
              runHostCommand: dependencies.runHostCommand,
              region:
                env.AWS_REGION ??
                env.AWS_DEFAULT_REGION ??
                readAwsDeviceFarmRegionFromArn(providerSessionId ?? ''),
            });
            return await listAwsDeviceFarmCloudArtifacts(provider, providerSessionId, client);
          },
          prepareSession: async ({ req, lease, base }) => {
            const request = requireRequest(req, 'AWS Device Farm');
            // Enforced here, not only in the CLI profile builder: the typed client and
            // hand-authored remote-config profiles both reach session preparation without passing
            // through `connect`, and would otherwise have these capabilities silently dropped.
            const { rejectUnsupportedProviderFeatures } =
              await import('./provider-feature-support.ts');
            rejectUnsupportedProviderFeatures(
              request.flags,
              CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
            );
            const platform = requireRequestPlatform(request, 'AWS Device Farm');
            const sessionOptions = {
              client: createAwsCliDeviceFarmClient({
                runHostCommand: dependencies.runHostCommand,
                region: readFlag(request, 'awsRegion') ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
              }),
              projectArn: requireAwsValue(
                request,
                env,
                'awsProjectArn',
                'AGENT_DEVICE_AWS_DEVICE_FARM_PROJECT_ARN',
                'AWS_DEVICE_FARM_PROJECT_ARN',
              ),
              deviceArn: requireAwsValue(
                request,
                env,
                'awsDeviceArn',
                'AGENT_DEVICE_AWS_DEVICE_FARM_DEVICE_ARN',
                'AWS_DEVICE_FARM_DEVICE_ARN',
              ),
              appArn:
                readFlag(request, 'awsAppArn') ??
                env.AGENT_DEVICE_AWS_DEVICE_FARM_APP_ARN ??
                env.AWS_DEVICE_FARM_APP_ARN,
              platform,
              deviceName: readFlag(request, 'device') ?? 'AWS Device Farm device',
              sessionName: readFlag(request, 'providerSessionName') ?? lease.leaseId,
              interactionMode: readAwsInteractionMode(request),
            };
            return await createAwsDeviceFarmPrepareSession(sessionOptions)({ lease, req, base });
          },
        }),
      listArtifactsFromEnv: async (providerSessionId, env) => {
        const client = createAwsCliDeviceFarmClient({
          runHostCommand: dependencies.runHostCommand,
          region:
            env.AWS_REGION ??
            env.AWS_DEFAULT_REGION ??
            readAwsDeviceFarmRegionFromArn(providerSessionId),
        });
        return await listAwsDeviceFarmCloudArtifacts(
          CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
          providerSessionId,
          client,
        );
      },
    },
  ];
}

async function resolveTestingBotAppReference(options: {
  api: TestingBotApiOptions;
  app: string;
  cwd?: string;
  platform: CloudWebDriverPlatform;
  signal?: AbortSignal;
}): Promise<string> {
  const { requireTestingBotAppCompatibility, waitForTestingBotStorage } =
    await import('./testingbot.ts');
  const reference = await uploadTestingBotAppReference(options);
  // The `tb://` is usable immediately; this only surfaces a platform or simulator-only mismatch
  // before a device is allocated, and gives up at its budget rather than blocking the session.
  const stored = await waitForTestingBotStorage(reference, options.api, { signal: options.signal });
  if (stored) requireTestingBotAppCompatibility(stored, options.platform);
  return reference;
}

async function uploadTestingBotAppReference(options: {
  api: TestingBotApiOptions;
  app: string;
  cwd?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { isTestingBotAppReference, uploadTestingBotApp } = await import('./testingbot.ts');
  const appPath = requireLocalAppPath(options, {
    isProviderReference: isTestingBotAppReference,
    message: 'TestingBot --provider-app must be a tb:// app key, URL, or existing local app path.',
  });
  if (appPath === undefined) return options.app;
  return await uploadTestingBotApp(appPath, options.api, options.signal);
}

function testingBotApiOptions(
  clientVersion: string,
  env: DefaultCloudWebDriverArtifactEnv,
  providerLabel: string,
): TestingBotApiOptions {
  return {
    clientVersion,
    key: requireTestingBotCredential(
      env.TESTINGBOT_KEY ?? env.TB_KEY,
      'TESTINGBOT_KEY',
      providerLabel,
    ),
    secret: requireTestingBotCredential(
      env.TESTINGBOT_SECRET ?? env.TB_SECRET,
      'TESTINGBOT_SECRET',
      providerLabel,
    ),
    endpoint: env.TESTINGBOT_API_ENDPOINT ?? TESTINGBOT_API_ENDPOINT,
  };
}

function requireTestingBotCredential(
  value: string | undefined,
  name: string,
  providerLabel: string,
): string {
  if (value) return value;
  throw new AppError('INVALID_ARGS', `${providerLabel} requires ${name} in the environment.`);
}

/**
 * TestingBot's `maxduration` is seconds. The flag crosses the lease envelope as a string (that
 * projection forwards strings and booleans only), so the bound is enforced here rather than handed
 * to the hub, which clamps an out-of-range value silently.
 */
function readTestingBotMaxDuration(req: LeaseLifecycleContext): number {
  return (
    readFlagInteger(req, 'providerMaxDuration', {
      min: 1,
      max: 86_400,
      flag: '--provider-max-duration',
    }) ?? TESTINGBOT_DEFAULT_MAX_DURATION_SECONDS
  );
}

async function resolveBrowserStackAppReference(options: {
  clientVersion: string;
  app: string;
  cwd?: string;
  username: string;
  accessKey: string;
  uploadEndpoint?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { uploadBrowserStackApp } = await import('./browserstack.ts');
  const appPath = requireLocalAppPath(options, {
    isProviderReference: isProviderAppReference,
    message: 'BrowserStack --provider-app must be a bs:// app id, URL, or existing local app path.',
  });
  if (appPath === undefined) return options.app;
  return await uploadBrowserStackApp(
    appPath,
    {
      clientVersion: options.clientVersion,
      username: options.username,
      accessKey: options.accessKey,
      endpoint: options.uploadEndpoint,
    },
    options.signal,
  );
}

function isProviderAppReference(value: string): boolean {
  return value.startsWith('bs://') || /^https?:\/\//.test(value);
}

/**
 * Resolves `--provider-app` to a local path that exists, or `undefined` when it is already a
 * provider reference the hub resolves itself.
 *
 * The existence check runs before allocation so a mistyped path fails while nothing is leased.
 */
function requireLocalAppPath(
  options: { app: string; cwd?: string },
  provider: { isProviderReference: (value: string) => boolean; message: string },
): string | undefined {
  if (provider.isProviderReference(options.app)) return undefined;
  const appPath = path.resolve(options.cwd ?? process.cwd(), options.app);
  if (!fs.existsSync(appPath)) {
    throw new AppError('INVALID_ARGS', provider.message, { providerApp: options.app });
  }
  return appPath;
}

function requireRequest(
  req: LeaseLifecycleContext | undefined,
  providerLabel: string,
): LeaseLifecycleContext {
  if (req) return req;
  throw new AppError(
    'INVALID_ARGS',
    `${providerLabel} lease allocation requires provider profile flags on the request.`,
  );
}

function requireRequestPlatform(
  req: LeaseLifecycleContext,
  providerLabel: string,
): CloudWebDriverPlatform {
  const platform = req.flags?.platform;
  if (platform === 'android' || platform === 'ios') return platform;
  throw new AppError('INVALID_ARGS', `${providerLabel} requires --platform ios|android.`);
}

function requireFlag(req: LeaseLifecycleContext, key: string, message: string): string {
  const value = readFlag(req, key);
  if (value) return value;
  throw new AppError('INVALID_ARGS', message);
}

function readFlag(req: LeaseLifecycleContext, key: string): string | undefined {
  const value = req.flags?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Reads a bounded integer flag off a request.
 *
 * Accepts `number` as well as `string`: the line transport forwards a request's flags verbatim, so
 * a typed client may pass a number, while the compact lease envelope carries the same flag as a
 * string. Both routes must land on the same value rather than one of them silently reading unset.
 */
function readFlagInteger(
  req: LeaseLifecycleContext,
  key: string,
  bounds: { min: number; max: number; flag: string },
): number | undefined {
  const parsed = readFlagNumber(req.flags?.[key]);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    throw new AppError('INVALID_ARGS', `Invalid ${bounds.flag} value: ${String(parsed)}.`, {
      hint: `Pass a whole number of seconds between ${bounds.min} and ${bounds.max}.`,
      flag: bounds.flag,
    });
  }
  return parsed;
}

function readFlagNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value === '') return undefined;
  return Number(value);
}

function requireEnv(
  env: DefaultCloudWebDriverProviderRuntimeEnv,
  key: keyof DefaultCloudWebDriverProviderRuntimeEnv,
  providerLabel: string,
): string {
  const value = env[key];
  if (value) return value;
  throw new AppError('INVALID_ARGS', `${providerLabel} requires ${key} in the environment.`);
}

function requireAwsValue(
  req: LeaseLifecycleContext,
  env: DefaultCloudWebDriverProviderRuntimeEnv,
  flagKey: string,
  primaryEnv: keyof DefaultCloudWebDriverProviderRuntimeEnv,
  fallbackEnv: keyof DefaultCloudWebDriverProviderRuntimeEnv,
): string {
  const value = readFlag(req, flagKey) ?? env[primaryEnv] ?? env[fallbackEnv];
  if (value) return value;
  throw new AppError(
    'INVALID_ARGS',
    `AWS Device Farm requires --${dasherize(String(flagKey))} or ${fallbackEnv}.`,
  );
}

function readAwsInteractionMode(
  req: LeaseLifecycleContext,
): 'INTERACTIVE' | 'NO_VIDEO' | 'VIDEO_ONLY' | undefined {
  const value = readFlag(req, 'awsInteractionMode');
  if (value === 'INTERACTIVE' || value === 'NO_VIDEO' || value === 'VIDEO_ONLY') return value;
  return undefined;
}

function dasherize(value: string): string {
  return value.replaceAll(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}
