import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { createProviderWebDriver } from './index.ts';
import type { RunHostCommand } from './dependencies.ts';

const API = 'https://api.testingbot.test/v1';
const testingBotOptions = {
  provider: 'testingbot' as const,
  key: 'tb-key',
  secret: 'tb-secret',
  platform: 'ios' as const,
  deviceName: 'iPhone 17 Pro',
  osVersion: '26.5',
  app: 'tb://app-key',
  apiEndpoint: API,
};

const DEVICES = [
  { id: 1, name: 'iPhone 17 Pro', platform_name: 'iOS', version: '26.5', available: true },
  { id: 2, name: 'iPhone 15', platform_name: 'iOS', version: '18.0', available: true },
  { id: 3, name: 'iPad (9th generation)', platform_name: 'iOS', version: '26.6', available: false },
  { id: 4, name: 'Pixel 8', platform_name: 'Android', version: '16.0', available: true },
];

afterEach(() => vi.unstubAllGlobals());

test('TestingBot verifies the selected device and uploaded app without creating a session', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (input) => routeTestingBot(String(input)));
  vi.stubGlobal('fetch', fetchMock);

  const result = await createProvider().verifyConnection(testingBotOptions);

  assert.equal(result.provider, 'testingbot');
  assert.equal(result.service, 'TestingBot');
  assert.deepEqual(result.device, {
    status: 'verified',
    name: 'iPhone 17 Pro',
    platform: 'ios',
    osVersion: '26.5',
  });
  assert.deepEqual(result.app, {
    status: 'verified',
    reference: 'tb://app-key',
    name: 'ZuperiOS.ipa',
    version: '1.0.0',
  });
  // Credentials are checked first: the device catalogue is public and answers 200 for anyone, so
  // verifying against it alone would report a device error for a bad key.
  assert.deepEqual(
    fetchMock.mock.calls.map(([input]) => String(input)),
    [`${API}/user`, `${API}/devices`, `${API}/storage/app-key`],
  );
});

test('TestingBot resolves a regular-expression device and OS selector', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) => routeTestingBot(String(input))),
  );

  const result = await createProvider().verifyConnection({
    ...testingBotOptions,
    deviceName: 'iPhone 17.*',
    osVersion: '26.*',
  });

  // The verified line names the concrete device the pattern resolved to, not the pattern.
  assert.equal(result.device?.name, 'iPhone 17 Pro');
  assert.equal(result.device?.osVersion, '26.5');
});

test('a device selector is anchored so a shorter name cannot match a longer one', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) => routeTestingBot(String(input))),
  );

  // Unanchored, "iPhone 1" would match "iPhone 15" and silently allocate the wrong device.
  await assert.rejects(
    createProvider().verifyConnection({ ...testingBotOptions, deviceName: 'iPhone 1' }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'INVALID_ARGS');
      return true;
    },
  );
});

test('TestingBot classifies rejected credentials without exposing them', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401)),
  );

  await assert.rejects(createProvider().verifyConnection(testingBotOptions), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'UNAUTHORIZED');
    assert.match(
      String((error as { details?: { hint?: string } }).details?.hint),
      /TESTINGBOT_KEY/,
    );
    assert.doesNotMatch(JSON.stringify(error), /tb-secret/);
    return true;
  });
});

test('an unmatched device lists the closest alternatives for that platform', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) => routeTestingBot(String(input))),
  );

  await assert.rejects(
    createProvider().verifyConnection({ ...testingBotOptions, deviceName: 'Galaxy S24' }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'INVALID_ARGS');
      const hint = String((error as { details?: { hint?: string } }).details?.hint);
      assert.match(hint, /iPhone 17 Pro \(26\.5\)/);
      // Android devices are not offered for an iOS session.
      assert.doesNotMatch(hint, /Pixel 8/);
      return true;
    },
  );
});

test('an app uploaded for the other platform is rejected before any session is created', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) =>
      String(input).includes('/storage/')
        ? jsonResponse({ app_url: 'tb://app-key', type: 'ANDROID', state: 'DONE' })
        : routeTestingBot(String(input)),
    ),
  );

  await assert.rejects(createProvider().verifyConnection(testingBotOptions), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'INVALID_ARGS');
    assert.match((error as Error).message, /is ANDROID, but the session platform is ios/);
    return true;
  });
});

test('a simulator-only upload is rejected for a real-device session', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) =>
      String(input).includes('/storage/')
        ? jsonResponse({ app_url: 'tb://app-key', type: 'IOS', state: 'DONE', sim_only: true })
        : routeTestingBot(String(input)),
    ),
  );

  await assert.rejects(createProvider().verifyConnection(testingBotOptions), (error: unknown) => {
    assert.match((error as Error).message, /simulator-only build/);
    return true;
  });
});

test('an app deleted from storage names the 62-day retention in its hint', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) =>
      String(input).includes('/storage/')
        ? jsonResponse({ error: 'not found' }, 404)
        : routeTestingBot(String(input)),
    ),
  );

  await assert.rejects(createProvider().verifyConnection(testingBotOptions), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'INVALID_ARGS');
    assert.match(String((error as { details?: { hint?: string } }).details?.hint), /62 days/);
    return true;
  });
});

test('a local artifact is verified by extension and uploaded later', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) => routeTestingBot(String(input))),
  );

  const result = await createProvider().verifyConnection({
    ...testingBotOptions,
    app: '/tmp/build/ZuperiOS.ipa',
  });

  assert.equal(result.app?.status, 'configured');
  assert.equal(result.app?.name, 'ZuperiOS.ipa');
});

test('a .zip is rejected for a real iOS device before connect saves the profile', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) => routeTestingBot(String(input))),
  );

  await assert.rejects(
    createProvider().verifyConnection({ ...testingBotOptions, app: '/tmp/build/App.zip' }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'INVALID_ARGS');
      assert.match(String((error as { details?: { hint?: string } }).details?.hint), /simulator/);
      return true;
    },
  );
});

function routeTestingBot(url: string): Response {
  if (url.endsWith('/user')) return jsonResponse({ id: 1, first_name: 'Agent' });
  if (url.endsWith('/devices')) return jsonResponse(DEVICES);
  if (url.includes('/storage/')) {
    return jsonResponse({
      app_url: 'tb://app-key',
      type: 'IOS',
      filename: 'ZuperiOS.ipa',
      version: '1.0.0',
      state: 'DONE',
      sim_only: false,
    });
  }
  throw new Error(`unexpected TestingBot request: ${url}`);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createProvider() {
  return createProviderWebDriver({
    clientVersion: '0.0.0-test',
    runHostCommand: unexpectedHostCommand,
  });
}

const unexpectedHostCommand: RunHostCommand = async () => {
  throw new Error('unexpected host command');
};
