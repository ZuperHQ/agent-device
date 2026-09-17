import type { CloudArtifact, CloudArtifactsResult } from '@agent-device/contracts/observability';
import {
  createCloudWebDriverCapabilities,
  type CloudWebDriverProviderCapabilities,
} from './capabilities.ts';
import {
  createCloudWebDriverRuntime,
  type CloudWebDriverPlatform,
  type CloudWebDriverRuntimeOptions,
  type CloudWebDriverUploadApp,
} from './runtime.ts';
import type { DeviceLease, ProviderDeviceRuntime } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  buildTestingBotDeviceFeatureCapabilities,
  type TestingBotDeviceFeatureFields,
} from './testingbot-device-features.ts';
import {
  CLOUD_WEBDRIVER_PROVIDERS,
  TESTINGBOT_API_ENDPOINT,
  TESTINGBOT_CAPABILITY_OVERRIDES,
  TESTINGBOT_DASHBOARD_TEST_URL,
  TESTINGBOT_DEFAULT_MAX_DURATION_SECONDS,
  TESTINGBOT_HUB_ENDPOINT,
  TESTINGBOT_IDLE_TIMEOUT_SECONDS,
  TESTINGBOT_NEW_COMMAND_TIMEOUT_SECONDS,
  type TestingBotApiOptions,
} from './providers.ts';
import { agentDeviceRequestHeaders } from './request-headers.ts';
import {
  basicAuthHeader,
  postProviderAppUpload,
  resolveLeaseValue,
  trimTrailingSlash,
  type LeaseValue,
} from './webdriver-utils.ts';

const TESTINGBOT_PROVIDER = CLOUD_WEBDRIVER_PROVIDERS.testingBot;
/** Storage metadata extraction only gates `type`/`sim_only` reporting, never the `tb://` itself. */
const TESTINGBOT_STORAGE_POLL_BUDGET_MS = 120_000;
const TESTINGBOT_STORAGE_POLL_INTERVAL_MS = 2_000;

export type TestingBotWebDriverRuntimeOptions = {
  clientVersion: string;
  key: string;
  secret: string;
  platform: CloudWebDriverPlatform;
  deviceName: string;
  osVersion: string;
  app?: string;
  buildName?: LeaseValue<string>;
  sessionName?: LeaseValue<string>;
  maxDurationSeconds?: number;
  tabletOnly?: boolean;
  deviceFeatures?: TestingBotDeviceFeatureFields;
  webdriverCapabilities?:
    | Record<string, unknown>
    | ((lease: DeviceLease) => Record<string, unknown>);
  endpoint?: string | URL;
  apiEndpoint?: string | URL;
  deviceId?: CloudWebDriverRuntimeOptions['deviceId'];
  requestPolicy?: CloudWebDriverRuntimeOptions['requestPolicy'];
  prepareSession?: CloudWebDriverRuntimeOptions['prepareSession'];
};

export type TestingBotCapabilitiesOptions = {
  platform: CloudWebDriverPlatform;
  key: string;
  secret: string;
  deviceName: string;
  osVersion: string;
  app?: string;
  buildName: string;
  sessionName: string;
  maxDurationSeconds?: number;
  tabletOnly?: boolean;
  /** Device-feature capabilities, already projected onto their TestingBot namespaces. */
  deviceFeatures?: { appium: Record<string, unknown>; testingBot: Record<string, unknown> };
  configured?: Record<string, unknown>;
};

/**
 * @internal TestingBot capability builder used by integration tests.
 */
export function getTestingBotWebDriverCapabilities(
  platform: CloudWebDriverPlatform,
): CloudWebDriverProviderCapabilities {
  return createCloudWebDriverCapabilities({
    provider: TESTINGBOT_PROVIDER,
    platform,
    overrides: TESTINGBOT_CAPABILITY_OVERRIDES,
  });
}

/**
 * @internal TestingBot runtime factory used by integration tests.
 */
export function createTestingBotWebDriverRuntime(
  options: TestingBotWebDriverRuntimeOptions,
): ProviderDeviceRuntime {
  const apiOptions = {
    clientVersion: options.clientVersion,
    key: options.key,
    secret: options.secret,
    endpoint: options.apiEndpoint ?? TESTINGBOT_API_ENDPOINT,
  };
  return createCloudWebDriverRuntime({
    clientVersion: options.clientVersion,
    provider: TESTINGBOT_PROVIDER,
    endpoint: options.endpoint ?? TESTINGBOT_HUB_ENDPOINT,
    platform: options.platform,
    deviceName: options.deviceName,
    webdriverCapabilities: (lease) =>
      buildTestingBotCapabilities({
        platform: options.platform,
        key: options.key,
        secret: options.secret,
        deviceName: options.deviceName,
        osVersion: options.osVersion,
        app: options.app,
        buildName: resolveLeaseValue(options.buildName, lease) ?? lease.runId,
        sessionName: resolveLeaseValue(options.sessionName, lease) ?? lease.leaseId,
        maxDurationSeconds: options.maxDurationSeconds,
        tabletOnly: options.tabletOnly,
        deviceFeatures: buildTestingBotDeviceFeatureCapabilities(
          options.deviceFeatures ?? {},
          options.platform,
        ),
        configured: resolveConfiguredTestingBotCapabilities(options, lease),
      }),
    uploadApp: createTestingBotUploadApp(apiOptions),
    listArtifacts: async ({ provider, providerSessionId }) =>
      await listTestingBotCloudArtifacts(provider, providerSessionId, apiOptions),
    deviceId: options.deviceId,
    prepareSession: options.prepareSession,
    requestPolicy: options.requestPolicy,
    capabilityOverrides: TESTINGBOT_CAPABILITY_OVERRIDES,
  });
}

/**
 * Builds the W3C capability set for one TestingBot session.
 *
 * The hub authenticates from `tb:options.key`/`secret` rather than the endpoint URL, so the
 * credentials are capabilities here and never land in a logged endpoint.
 */
export function buildTestingBotCapabilities(
  options: TestingBotCapabilitiesOptions,
): Record<string, unknown> {
  const { 'tb:options': configuredTbOptions, ...configured } = options.configured ?? {};
  return {
    'appium:automationName': options.platform === 'ios' ? 'XCUITest' : 'UiAutomator2',
    'appium:platformVersion': options.osVersion,
    ...(options.app ? { 'appium:app': options.app } : {}),
    'appium:newCommandTimeout': TESTINGBOT_NEW_COMMAND_TIMEOUT_SECONDS,
    ...(options.deviceFeatures?.appium ?? {}),
    ...configured,
    // Merged per key, never assigned: `configured` carrying its own `tb:options` would otherwise
    // replace the whole object and silently drop the credentials and session labels below.
    'tb:options': {
      key: options.key,
      secret: options.secret,
      // agent-device drives physical devices; without this TestingBot may route to a simulator.
      realDevice: true,
      name: options.sessionName,
      build: options.buildName,
      idletimeout: TESTINGBOT_IDLE_TIMEOUT_SECONDS,
      maxduration: options.maxDurationSeconds ?? TESTINGBOT_DEFAULT_MAX_DURATION_SECONDS,
      screenrecorder: true,
      public: false,
      ...(options.tabletOnly ? { tabletOnly: true } : {}),
      ...(options.deviceFeatures?.testingBot ?? {}),
      ...asRecord(configuredTbOptions),
    },
  };
}

export type TestingBotStorageApp = {
  appUrl: string;
  type?: string;
  version?: string;
  filename?: string;
  state?: string;
  simOnly?: boolean;
};

export async function uploadTestingBotApp(
  appPath: string,
  options: TestingBotApiOptions,
  signal?: AbortSignal,
): Promise<string> {
  const response = await postProviderAppUpload({
    appPath,
    endpoint: testingBotApiUrl(options.endpoint, '/storage'),
    headers: {
      ...agentDeviceRequestHeaders(options.clientVersion),
      Authorization: testingBotAuthHeader(options),
    },
    signal,
  });
  const json = (await response.json()) as unknown;
  const appUrl = readTestingBotAppUrl(json);
  if (!response.ok || !appUrl) {
    throw new AppError('COMMAND_FAILED', 'TestingBot app upload failed.', {
      status: response.status,
      response: json,
    });
  }
  return appUrl;
}

export function createTestingBotUploadApp(options: TestingBotApiOptions): CloudWebDriverUploadApp {
  return async ({ appPath, options: installOptions, signal }) => {
    const appReference = await uploadTestingBotApp(appPath, options, signal);
    return {
      appReference,
      bundleId: installOptions?.appIdentifierHint,
      packageName: installOptions?.packageNameHint,
      launchTarget: installOptions?.appIdentifierHint ?? installOptions?.packageNameHint,
    };
  };
}

export async function fetchTestingBotStorageApp(
  appReference: string,
  options: TestingBotApiOptions,
  signal?: AbortSignal,
): Promise<TestingBotStorageApp | undefined> {
  const appKey = testingBotAppKey(appReference);
  const response = await fetch(
    testingBotApiUrl(options.endpoint, `/storage/${encodeURIComponent(appKey)}`),
    {
      headers: {
        ...agentDeviceRequestHeaders(options.clientVersion),
        Authorization: testingBotAuthHeader(options),
      },
      signal,
    },
  );
  if (response.status === 404) return undefined;
  const json = (await response.json()) as unknown;
  if (!response.ok || !json || typeof json !== 'object') {
    throw new AppError('COMMAND_FAILED', 'TestingBot storage lookup failed.', {
      status: response.status,
      response: json,
    });
  }
  return readTestingBotStorageApp(json as Record<string, unknown>, appReference);
}

/**
 * Waits for TestingBot to finish extracting an upload's metadata.
 *
 * The `tb://` reference is usable the moment the upload returns; only `type`, `version` and
 * `sim_only` wait on extraction. So this polls to surface a platform or simulator-only mismatch
 * early and gives up at the budget rather than blocking a session that would have started.
 */
export async function waitForTestingBotStorage(
  appReference: string,
  options: TestingBotApiOptions,
  waitOptions?: { signal?: AbortSignal; budgetMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<TestingBotStorageApp | undefined> {
  const budgetMs = waitOptions?.budgetMs ?? TESTINGBOT_STORAGE_POLL_BUDGET_MS;
  const sleep = waitOptions?.sleep ?? defaultSleep;
  const deadline = Date.now() + budgetMs;
  let latest: TestingBotStorageApp | undefined;
  for (;;) {
    waitOptions?.signal?.throwIfAborted();
    latest = await fetchTestingBotStorageApp(appReference, options, waitOptions?.signal);
    if (!latest || latest.state !== 'PROCESSING') return latest;
    if (Date.now() + TESTINGBOT_STORAGE_POLL_INTERVAL_MS >= deadline) return latest;
    await sleep(TESTINGBOT_STORAGE_POLL_INTERVAL_MS);
  }
}

/** Fails when an upload cannot run on the session's platform as a real device. */
export function requireTestingBotAppCompatibility(
  app: TestingBotStorageApp,
  platform: CloudWebDriverPlatform,
): void {
  const expected = platform === 'ios' ? 'IOS' : 'ANDROID';
  if (app.type && app.type !== expected) {
    throw new AppError(
      'INVALID_ARGS',
      `TestingBot app ${app.appUrl} is ${app.type}, but the session platform is ${platform}.`,
      {
        hint: `Upload a ${platform === 'ios' ? '.ipa' : '.apk or .aab'} or connect with --platform ${app.type === 'IOS' ? 'ios' : 'android'}.`,
        providerApp: app.appUrl,
      },
    );
  }
  if (platform === 'ios' && app.simOnly === true) {
    throw new AppError(
      'INVALID_ARGS',
      `TestingBot app ${app.appUrl} is a simulator-only build and cannot install on a real device.`,
      {
        hint: 'Upload a device-signed .ipa; a .zip simulator build only runs on iOS simulators.',
        providerApp: app.appUrl,
      },
    );
  }
}

export async function listTestingBotCloudArtifacts(
  provider: string,
  providerSessionId: string | undefined,
  options: TestingBotApiOptions,
): Promise<CloudArtifactsResult | undefined> {
  if (!providerSessionId) return undefined;
  const details = await fetchTestingBotTest(providerSessionId, options);
  const dashboard = testingBotDashboardArtifact(provider, providerSessionId);
  // The dashboard link exists from the moment the session does, so a non-empty artifact list is
  // not evidence that anything is downloadable. TestingBot says so explicitly with
  // `assets_available`; until it flips, report pending with the link alone.
  if (details.assets_available !== true) {
    return {
      provider,
      providerSessionId,
      status: 'pending',
      cloudArtifacts: [dashboard],
      message: 'TestingBot artifacts are still processing.',
    };
  }
  const assets = await fetchTestingBotAssets(providerSessionId, options);
  return {
    provider,
    providerSessionId,
    status: 'ready',
    cloudArtifacts: [...mapTestingBotAssets(provider, providerSessionId, assets), dashboard],
  };
}

/**
 * Reports the session outcome to TestingBot.
 *
 * TestingBot marks a session whose result was never reported as "unknown", which hides real
 * failures in its dashboard and analytics, so release always states one.
 */
export async function markTestingBotSession(
  providerSessionId: string,
  result: { success: boolean; statusMessage?: string },
  options: TestingBotApiOptions,
  signal?: AbortSignal,
): Promise<void> {
  const body = new URLSearchParams({ 'test[success]': result.success ? '1' : '0' });
  if (result.statusMessage) body.set('test[status_message]', result.statusMessage);
  const response = await fetch(
    testingBotApiUrl(options.endpoint, `/tests/${encodeURIComponent(providerSessionId)}`),
    {
      method: 'PUT',
      headers: {
        ...agentDeviceRequestHeaders(options.clientVersion),
        Authorization: testingBotAuthHeader(options),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      signal,
    },
  );
  if (!response.ok) {
    throw new AppError('COMMAND_FAILED', 'TestingBot session status update failed.', {
      status: response.status,
      providerSessionId,
    });
  }
}

export function testingBotApiUrl(endpoint: string | URL | undefined, suffix: string): URL {
  return new URL(`${trimTrailingSlash(String(endpoint ?? TESTINGBOT_API_ENDPOINT))}${suffix}`);
}

export function testingBotAuthHeader(credentials: { key: string; secret: string }): string {
  return basicAuthHeader({ username: credentials.key, accessKey: credentials.secret });
}

/** `tb://<appkey>` and a bare appkey both address the same storage object. */
function testingBotAppKey(appReference: string): string {
  return appReference.startsWith('tb://') ? appReference.slice('tb://'.length) : appReference;
}

export function isTestingBotAppReference(value: string): boolean {
  return value.startsWith('tb://') || /^https?:\/\//i.test(value);
}

async function fetchTestingBotTest(
  providerSessionId: string,
  options: TestingBotApiOptions,
): Promise<Record<string, unknown>> {
  return await fetchTestingBotJson(
    testingBotApiUrl(options.endpoint, `/tests/${encodeURIComponent(providerSessionId)}`),
    options,
    'TestingBot session details lookup failed.',
  );
}

async function fetchTestingBotAssets(
  providerSessionId: string,
  options: TestingBotApiOptions,
): Promise<Record<string, unknown>> {
  return await fetchTestingBotJson(
    testingBotApiUrl(options.endpoint, `/tests/${encodeURIComponent(providerSessionId)}/assets`),
    options,
    'TestingBot session assets lookup failed.',
  );
}

async function fetchTestingBotJson(
  url: URL,
  options: TestingBotApiOptions,
  failureMessage: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: {
      ...agentDeviceRequestHeaders(options.clientVersion),
      Authorization: testingBotAuthHeader(options),
    },
  });
  const json = (await response.json()) as unknown;
  if (!response.ok || !json || typeof json !== 'object') {
    throw new AppError('COMMAND_FAILED', failureMessage, {
      status: response.status,
      response: json,
    });
  }
  return json as Record<string, unknown>;
}

function mapTestingBotAssets(
  provider: string,
  providerSessionId: string,
  assets: Record<string, unknown>,
): CloudArtifact[] {
  return [
    ...testingBotVideoArtifact(provider, providerSessionId, assets),
    ...testingBotLogArtifacts(provider, providerSessionId, assets),
    ...testingBotScreenshotArtifacts(provider, providerSessionId, assets),
  ];
}

function testingBotVideoArtifact(
  provider: string,
  providerSessionId: string,
  assets: Record<string, unknown>,
): CloudArtifact[] {
  // `video` is `false` rather than absent when recording was disabled for the session.
  const url = assets.video;
  if (typeof url !== 'string' || url.length === 0) return [];
  return [
    {
      provider,
      providerSessionId,
      kind: 'video',
      name: 'Session video',
      url,
      availability: 'ready',
    },
  ];
}

function testingBotLogArtifacts(
  provider: string,
  providerSessionId: string,
  assets: Record<string, unknown>,
): CloudArtifact[] {
  const logs = assets.logs;
  if (!logs || typeof logs !== 'object' || Array.isArray(logs)) return [];
  return Object.entries(logs as Record<string, unknown>).flatMap(([name, url]) =>
    typeof url === 'string' && url.length > 0
      ? [
          {
            provider,
            providerSessionId,
            kind: testingBotLogKind(name),
            name: `${name} log`,
            url,
            availability: 'ready' as const,
          },
        ]
      : [],
  );
}

function testingBotLogKind(name: string): CloudArtifact['kind'] {
  if (name === 'appium') return 'appium-log';
  if (name === 'logcat' || name === 'android' || name === 'device') return 'device-log';
  if (name === 'selenium') return 'automation-log';
  return 'raw';
}

function testingBotScreenshotArtifacts(
  provider: string,
  providerSessionId: string,
  assets: Record<string, unknown>,
): CloudArtifact[] {
  const screenshots = assets.screenshots;
  if (!Array.isArray(screenshots)) return [];
  return screenshots.flatMap((url, index) =>
    typeof url === 'string' && url.length > 0
      ? [
          {
            provider,
            providerSessionId,
            kind: 'raw' as const,
            name: `Screenshot ${index + 1}`,
            url,
            availability: 'ready' as const,
          },
        ]
      : [],
  );
}

function testingBotDashboardArtifact(provider: string, providerSessionId: string): CloudArtifact {
  return {
    provider,
    providerSessionId,
    kind: 'provider-session',
    name: 'TestingBot dashboard',
    url: `${TESTINGBOT_DASHBOARD_TEST_URL}/${providerSessionId}`,
    availability: 'ready',
  };
}

function readTestingBotStorageApp(
  record: Record<string, unknown>,
  fallbackReference: string,
): TestingBotStorageApp {
  return {
    appUrl: typeof record.app_url === 'string' ? record.app_url : fallbackReference,
    ...(typeof record.type === 'string' ? { type: record.type } : {}),
    ...(typeof record.version === 'string' ? { version: record.version } : {}),
    ...(typeof record.filename === 'string' ? { filename: record.filename } : {}),
    ...(typeof record.state === 'string' ? { state: record.state } : {}),
    ...(typeof record.sim_only === 'boolean' ? { simOnly: record.sim_only } : {}),
  };
}

function readTestingBotAppUrl(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const appUrl = (value as { app_url?: unknown }).app_url;
  return typeof appUrl === 'string' ? appUrl : undefined;
}

function resolveConfiguredTestingBotCapabilities(
  options: TestingBotWebDriverRuntimeOptions,
  lease: DeviceLease,
): Record<string, unknown> {
  return typeof options.webdriverCapabilities === 'function'
    ? options.webdriverCapabilities(lease)
    : (options.webdriverCapabilities ?? {});
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
