import type { ProviderWebDriverDependencies } from './dependencies.ts';
import type { ProviderConnectionVerification } from '@agent-device/contracts/remote';
import { verifyAwsDeviceFarmConnection } from './aws-device-farm-connection-verification.ts';
import { verifyBrowserStackConnection } from './browserstack-connection-verification.ts';

export { readAwsDeviceFarmRegionFromArn } from './aws-device-farm-connection-verification.ts';

export type CloudWebDriverConnectionVerification =
  | (ProviderConnectionVerification & {
      provider: 'browserstack';
      service: 'BrowserStack';
      project?: never;
    })
  | (ProviderConnectionVerification & {
      provider: 'testingbot';
      service: 'TestingBot';
      project?: never;
    })
  | (ProviderConnectionVerification & {
      provider: 'aws-device-farm';
      service: 'AWS Device Farm';
      project: { name?: string; reference: string };
    });

export type CloudWebDriverConnectionVerificationOptions =
  | {
      provider: 'browserstack';
      username: string;
      accessKey: string;
      platform: 'android' | 'ios';
      deviceName: string;
      osVersion: string;
      app: string;
      devicesEndpoint?: string | URL;
      appsEndpoint?: string | URL;
    }
  | {
      provider: 'testingbot';
      key: string;
      secret: string;
      platform: 'android' | 'ios';
      deviceName: string;
      osVersion: string;
      app: string;
      apiEndpoint?: string | URL;
      devicesEndpoint?: string | URL;
    }
  | {
      provider: 'aws-device-farm';
      platform: 'android' | 'ios';
      projectArn: string;
      deviceArn: string;
      appArn?: string;
      region?: string;
    };

export async function verifyCloudWebDriverConnection(
  options: CloudWebDriverConnectionVerificationOptions,
  dependencies: ProviderWebDriverDependencies,
): Promise<CloudWebDriverConnectionVerification> {
  if (options.provider === 'browserstack') {
    return await verifyBrowserStackConnection(options, dependencies.clientVersion);
  }
  if (options.provider === 'testingbot') {
    // Verification runs once, at `connect`; loading its adapter costs every other command nothing.
    const { verifyTestingBotConnection } = await import('./testingbot-connection-verification.ts');
    return await verifyTestingBotConnection(options, dependencies.clientVersion);
  }
  return await verifyAwsDeviceFarmConnection(options, dependencies.runHostCommand);
}
