import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  buildTestingBotCapabilities,
  listTestingBotCloudArtifacts,
  markTestingBotSession,
  requireTestingBotAppCompatibility,
  uploadTestingBotApp,
  waitForTestingBotStorage,
} from './testingbot.ts';
import { mkdtempForTest } from './tmp-dir.fixtures.ts';

const API = 'https://api.testingbot.test/v1';
const apiOptions = {
  clientVersion: '0.0.0-test',
  key: 'tb-key',
  secret: 'tb-secret',
  endpoint: API,
};
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllGlobals();
});

const baseCapabilityOptions = {
  platform: 'ios' as const,
  key: 'tb-key',
  secret: 'tb-secret',
  deviceName: 'iPhone 17.*',
  osVersion: '26.*',
  app: 'tb://app-key',
  buildName: 'run-a',
  sessionName: 'lease-a',
};

test('iOS capabilities pin a real device and timeouts an agent session can survive', () => {
  const capabilities = buildTestingBotCapabilities(baseCapabilityOptions);

  assert.equal(capabilities['appium:automationName'], 'XCUITest');
  assert.equal(capabilities['appium:platformVersion'], '26.*');
  assert.equal(capabilities['appium:app'], 'tb://app-key');
  // TestingBot's 130 s idle default reaps a session while an agent is thinking between commands.
  assert.equal(capabilities['appium:newCommandTimeout'], 600);
  assert.deepEqual(capabilities['tb:options'], {
    key: 'tb-key',
    secret: 'tb-secret',
    realDevice: true,
    name: 'lease-a',
    build: 'run-a',
    idletimeout: 600,
    maxduration: 7200,
    screenrecorder: true,
    public: false,
  });
});

test('Android capabilities select the UiAutomator2 driver', () => {
  const capabilities = buildTestingBotCapabilities({
    ...baseCapabilityOptions,
    platform: 'android',
    deviceName: 'Pixel.*',
    osVersion: '16.*',
  });

  assert.equal(capabilities['appium:automationName'], 'UiAutomator2');
  assert.equal((capabilities['tb:options'] as Record<string, unknown>).realDevice, true);
});

test('tabletOnly and an explicit max duration reach tb:options', () => {
  const capabilities = buildTestingBotCapabilities({
    ...baseCapabilityOptions,
    deviceName: 'iPad.*',
    maxDurationSeconds: 3600,
    tabletOnly: true,
  });

  const tbOptions = capabilities['tb:options'] as Record<string, unknown>;
  assert.equal(tbOptions.tabletOnly, true);
  assert.equal(tbOptions.maxduration, 3600);
});

test('device features merge into tb:options rather than replacing the session labels', () => {
  const capabilities = buildTestingBotCapabilities({
    ...baseCapabilityOptions,
    deviceFeatures: {
      appium: { 'appium:orientation': 'LANDSCAPE' },
      testingBot: { timeZone: 'Europe/Brussels', resigningEnabled: false },
    },
    configured: { platformName: 'iOS', 'appium:deviceName': 'iPhone 17.*' },
  });

  assert.equal(capabilities['appium:orientation'], 'LANDSCAPE');
  const tbOptions = capabilities['tb:options'] as Record<string, unknown>;
  assert.equal(tbOptions.timeZone, 'Europe/Brussels');
  assert.equal(tbOptions.resigningEnabled, false);
  // The labels and credentials survive alongside them.
  assert.equal(tbOptions.name, 'lease-a');
  assert.equal(tbOptions.key, 'tb-key');
  assert.equal(tbOptions.realDevice, true);
});

test('app upload posts the binary and returns the tb:// reference', async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      assert.ok(init?.body instanceof FormData);
      assert.ok((init.body as FormData).get('file'));
      return jsonResponse({ app_url: 'tb://uploaded-app' });
    }),
  );

  await withTempApp('App.ipa', async (appPath) => {
    const reference = await uploadTestingBotApp(appPath, apiOptions);
    assert.equal(reference, 'tb://uploaded-app');
  });
  assert.deepEqual(calls, [`POST ${API}/storage`]);
});

test('a rejected upload fails without leaking the secret', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({ error: 'quota exceeded' }, 403)),
  );

  await withTempApp('App.ipa', async (appPath) => {
    await assert.rejects(uploadTestingBotApp(appPath, apiOptions), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.status, 403);
      assert.doesNotMatch(JSON.stringify(error), /tb-secret/);
      return true;
    });
  });
});

test('upload aborts while the provider request is in flight', async () => {
  const controller = new AbortController();
  const abortReason = new Error('request cancelled during TestingBot upload');
  globalThis.fetch = async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      assert.equal(init?.signal, controller.signal);
      if (init?.signal?.aborted) {
        reject(init.signal.reason);
        return;
      }
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });

  await withTempApp('App.ipa', async (appPath) => {
    const pending = uploadTestingBotApp(appPath, apiOptions, controller.signal);
    await Promise.resolve();
    controller.abort(abortReason);
    await assert.rejects(pending, (error: unknown) => error === abortReason);
  });
});

test('storage polling waits for metadata extraction to finish', async () => {
  const states = ['PROCESSING', 'PROCESSING', 'DONE'];
  let call = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      jsonResponse({
        app_url: 'tb://app-key',
        type: 'IOS',
        version: '1.0.0',
        state: states[call++],
        sim_only: false,
      }),
    ),
  );

  const stored = await waitForTestingBotStorage('tb://app-key', apiOptions, {
    sleep: async () => {},
  });

  assert.equal(call, 3);
  assert.equal(stored?.state, 'DONE');
  assert.equal(stored?.type, 'IOS');
});

test('storage polling gives up at its budget instead of blocking a usable tb:// reference', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse({ app_url: 'tb://app-key', state: 'PROCESSING' })),
  );

  // The reference is usable the moment upload returns; only the metadata is still extracting, so
  // exhausting the budget must report what is known rather than fail the session.
  const stored = await waitForTestingBotStorage('tb://app-key', apiOptions, {
    budgetMs: 0,
    sleep: async () => {},
  });

  assert.equal(stored?.state, 'PROCESSING');
});

test('a simulator-only build is rejected before a real device is allocated', () => {
  assert.throws(
    () =>
      requireTestingBotAppCompatibility(
        { appUrl: 'tb://app-key', type: 'IOS', simOnly: true },
        'ios',
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.match(error.message, /simulator-only build/);
      return true;
    },
  );
});

test('an app uploaded for the other platform is rejected with a recovery hint', () => {
  assert.throws(
    () => requireTestingBotAppCompatibility({ appUrl: 'tb://app-key', type: 'ANDROID' }, 'ios'),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.match(error.message, /is ANDROID, but the session platform is ios/);
      assert.match(String(error.details?.hint), /--platform android/);
      return true;
    },
  );
});

test('artifacts stay pending until TestingBot reports its assets are available', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      assert.equal(String(input), `${API}/tests/wd-1`);
      return jsonResponse({ session_id: 'wd-1', state: 'COMPLETE', assets_available: false });
    }),
  );

  const result = await listTestingBotCloudArtifacts('testingbot', 'wd-1', apiOptions);

  // The dashboard link exists from the moment the session does, so a non-empty list is not
  // evidence anything is downloadable — only `assets_available` is.
  assert.equal(result?.status, 'pending');
  assert.deepEqual(
    result?.cloudArtifacts.map((artifact) => artifact.kind),
    ['provider-session'],
  );
  assert.match(String(result?.message), /still processing/);
});

test('ready artifacts map video, logs, and screenshots onto their kinds', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) =>
      String(input).endsWith('/assets')
        ? jsonResponse({
            session_id: 'wd-1',
            video: 'https://tb.example/video.mp4',
            logs: {
              appium: 'https://tb.example/appium.log',
              logcat: 'https://tb.example/logcat.log',
            },
            har: null,
            screenshots: ['https://tb.example/1.jpg'],
          })
        : jsonResponse({ session_id: 'wd-1', state: 'COMPLETE', assets_available: true }),
    ),
  );

  const result = await listTestingBotCloudArtifacts('testingbot', 'wd-1', apiOptions);

  assert.equal(result?.status, 'ready');
  assert.deepEqual(
    result?.cloudArtifacts.map((artifact) => artifact.kind),
    ['video', 'appium-log', 'device-log', 'raw', 'provider-session'],
  );
  assert.equal(result?.cloudArtifacts.at(-1)?.url, 'https://testingbot.com/members/tests/wd-1');
});

test('a session recorded without video reports its remaining artifacts', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) =>
      String(input).endsWith('/assets')
        ? // `video` is `false`, not absent, when recording was disabled for the session.
          jsonResponse({ session_id: 'wd-1', video: false, logs: {}, screenshots: [] })
        : jsonResponse({ session_id: 'wd-1', assets_available: true }),
    ),
  );

  const result = await listTestingBotCloudArtifacts('testingbot', 'wd-1', apiOptions);

  assert.equal(result?.status, 'ready');
  assert.deepEqual(
    result?.cloudArtifacts.map((artifact) => artifact.kind),
    ['provider-session'],
  );
});

test('release reports the session outcome so TestingBot does not record it as unknown', async () => {
  const calls: Array<{ url: string; method?: string; body: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: String(init?.body),
      });
      return jsonResponse({ success: true });
    }),
  );

  await markTestingBotSession(
    'wd-1',
    { success: true, statusMessage: 'agent-device lease lease-a released' },
    apiOptions,
  );

  assert.equal(calls[0]?.url, `${API}/tests/wd-1`);
  assert.equal(calls[0]?.method, 'PUT');
  assert.match(calls[0]?.body ?? '', /test%5Bsuccess%5D=1/);
  assert.match(calls[0]?.body ?? '', /test%5Bstatus_message%5D=/);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function withTempApp(name: string, run: (appPath: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtempForTest('agent-device-testingbot-upload-');
  try {
    const appPath = path.join(tempDir, name);
    await fs.writeFile(appPath, 'placeholder');
    await run(appPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
