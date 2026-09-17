import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { agentDeviceRequestHeaders } from './request-headers.ts';
import {
  fetchTestingBotStorageApp,
  requireTestingBotAppCompatibility,
  testingBotApiUrl,
  testingBotAuthHeader,
} from './testingbot.ts';
import { TESTINGBOT_API_ENDPOINT } from './providers.ts';
import type {
  CloudWebDriverConnectionVerification,
  CloudWebDriverConnectionVerificationOptions,
} from './connection-verification.ts';
import type { ProviderConnectionResource } from '@agent-device/contracts/remote';

const TESTINGBOT_APP_EXTENSIONS = {
  ios: ['.ipa'],
  android: ['.apk', '.aab'],
} as const;
/** How many alternatives an unmatched device selector reports, so the error stays readable. */
const TESTINGBOT_DEVICE_SUGGESTION_LIMIT = 5;

type TestingBotOptions = Extract<
  CloudWebDriverConnectionVerificationOptions,
  { provider: 'testingbot' }
>;

type TestingBotDevice = {
  name: string;
  platformName: string;
  version: string;
  available: boolean;
};

export async function verifyTestingBotConnection(
  options: TestingBotOptions,
  clientVersion: string,
): Promise<CloudWebDriverConnectionVerification> {
  await verifyTestingBotCredentials(options, clientVersion);
  const device = await verifyTestingBotDevice(options, clientVersion);
  const app = await verifyTestingBotApp(options, clientVersion);
  return {
    provider: 'testingbot',
    service: 'TestingBot',
    verificationMessage:
      app.status === 'verified'
        ? 'Credentials, device, and uploaded app verified.'
        : 'Credentials and device access verified; app availability is checked when the session is created.',
    device: {
      status: 'verified',
      name: device.name,
      platform: options.platform,
      osVersion: device.version,
    },
    app,
  };
}

/**
 * Credentials are checked against an authenticated endpoint before anything else, so rejected keys
 * report as `UNAUTHORIZED` naming the environment variables rather than as a device mismatch: the
 * device catalogue is public and answers 200 for anyone.
 */
async function verifyTestingBotCredentials(
  options: TestingBotOptions,
  clientVersion: string,
): Promise<void> {
  await fetchTestingBotVerificationJson(
    testingBotApiUrl(options.apiEndpoint, '/user'),
    options,
    clientVersion,
  );
}

async function verifyTestingBotDevice(
  options: TestingBotOptions,
  clientVersion: string,
): Promise<TestingBotDevice> {
  const catalogue = await fetchTestingBotVerificationJson(
    options.devicesEndpoint ?? testingBotApiUrl(options.apiEndpoint, '/devices'),
    options,
    clientVersion,
  );
  const devices = readTestingBotDevices(catalogue).filter(
    (device) => device.platformName.toLowerCase() === options.platform,
  );
  const matched = devices.filter(
    (device) =>
      matchesSelector(device.name, options.deviceName) &&
      matchesSelector(device.version, options.osVersion),
  );
  const preferred = matched.find((device) => device.available) ?? matched[0];
  if (!preferred) {
    throw new AppError(
      'INVALID_ARGS',
      `No TestingBot ${options.platform} device matches "${options.deviceName}" on ${options.osVersion}.`,
      {
        hint: `Device name and OS version accept exact values or regular expressions, for example --device "iPhone 17.*" --provider-os-version "26.*". Available: ${describeDevices(devices)}.`,
        device: options.deviceName,
        osVersion: options.osVersion,
      },
    );
  }
  return preferred;
}

async function verifyTestingBotApp(
  options: TestingBotOptions,
  clientVersion: string,
): Promise<ProviderConnectionResource> {
  const { app } = options;
  if (app.startsWith('tb://')) {
    return await verifyTestingBotStorageApp(options, clientVersion, app);
  }
  if (/^https?:\/\//i.test(app)) {
    return {
      status: 'configured',
      reference: app,
      message: 'Public app URL configured; TestingBot validates it when creating the session.',
    };
  }
  requireTestingBotAppExtension(app, options.platform);
  return {
    status: 'configured',
    name: path.basename(app),
    reference: app,
    message: 'Local app artifact is ready and will be uploaded when creating the session.',
  };
}

async function verifyTestingBotStorageApp(
  options: TestingBotOptions,
  clientVersion: string,
  app: string,
): Promise<ProviderConnectionResource> {
  const stored = await withTestingBotVerificationErrors(
    async () =>
      await fetchTestingBotStorageApp(app, {
        clientVersion,
        key: options.key,
        secret: options.secret,
        endpoint: options.apiEndpoint,
      }),
  );
  if (!stored) {
    throw new AppError('INVALID_ARGS', `TestingBot app ${app} was not found in storage.`, {
      hint: 'Upload the app again; TestingBot Storage deletes uploads after 62 days.',
      providerApp: app,
    });
  }
  requireTestingBotAppCompatibility(stored, options.platform);
  return {
    status: 'verified',
    reference: stored.appUrl,
    ...(stored.filename ? { name: stored.filename } : {}),
    ...(stored.version ? { version: stored.version } : {}),
  };
}

function requireTestingBotAppExtension(app: string, platform: 'android' | 'ios'): void {
  const extensions = TESTINGBOT_APP_EXTENSIONS[platform];
  const extension = path.extname(app).toLowerCase();
  if ((extensions as readonly string[]).includes(extension)) return;
  throw new AppError(
    'INVALID_ARGS',
    `TestingBot ${platform} sessions need ${extensions.join(' or ')}, not "${extension || app}".`,
    {
      hint:
        platform === 'ios'
          ? 'Real iOS devices install a device-signed .ipa; a .zip is a simulator-only build.'
          : 'Upload an .apk or .aab.',
      providerApp: app,
    },
  );
}

/**
 * A selector is an exact name or a regular expression — TestingBot's own device-allocation syntax
 * (`iPhone 17.*`), anchored here so `iPhone 1` cannot match `iPhone 15`.
 */
function matchesSelector(value: string, selector: string): boolean {
  if (value === selector) return true;
  try {
    return new RegExp(`^(?:${selector})$`).test(value);
  } catch {
    return false;
  }
}

function describeDevices(devices: readonly TestingBotDevice[]): string {
  if (devices.length === 0) return 'none';
  const names = devices
    .slice(0, TESTINGBOT_DEVICE_SUGGESTION_LIMIT)
    .map((device) => `${device.name} (${device.version})`);
  const remaining = devices.length - names.length;
  return remaining > 0 ? `${names.join(', ')}, and ${remaining} more` : names.join(', ');
}

async function fetchTestingBotVerificationJson(
  endpoint: string | URL,
  options: TestingBotOptions,
  clientVersion: string,
): Promise<unknown> {
  return await withTestingBotVerificationErrors(async () => {
    const response = await fetch(endpoint, {
      headers: {
        ...agentDeviceRequestHeaders(clientVersion),
        Authorization: testingBotAuthHeader(options),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const unauthorized = response.status === 401 || response.status === 403;
      throw new AppError(
        unauthorized ? 'UNAUTHORIZED' : 'COMMAND_FAILED',
        'TestingBot rejected connection verification.',
        {
          status: response.status,
          hint: unauthorized
            ? 'Check TESTINGBOT_KEY and TESTINGBOT_SECRET.'
            : 'Retry connect or check the TestingBot service status.',
        },
      );
    }
    return (await response.json()) as unknown;
  });
}

async function withTestingBotVerificationErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      'COMMAND_FAILED',
      'TestingBot connection verification failed.',
      { hint: `Check network access to ${TESTINGBOT_API_ENDPOINT} and retry connect.` },
      error,
    );
  }
}

function readTestingBotDevices(value: unknown): TestingBotDevice[] {
  if (!Array.isArray(value)) {
    throw new AppError('COMMAND_FAILED', 'TestingBot device verification response was not a list.');
  }
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const version = record?.version;
    return record &&
      typeof record.name === 'string' &&
      typeof record.platform_name === 'string' &&
      (typeof version === 'string' || typeof version === 'number')
      ? [
          {
            name: record.name,
            platformName: record.platform_name,
            version: String(version),
            available: record.available !== false,
          },
        ]
      : [];
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
