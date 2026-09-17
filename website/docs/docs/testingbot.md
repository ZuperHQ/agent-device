---
title: TestingBot
description: Drive TestingBot real-device Appium sessions with agent-device.
---

# TestingBot

Use TestingBot for hosted Android and iOS WebDriver sessions on real devices.

## Credentials and connection

Set TestingBot credentials in a non-interactive environment:

```bash
export TESTINGBOT_KEY=...
export TESTINGBOT_SECRET=...
```

`TB_KEY` and `TB_SECRET`, the names TestingBot's own tooling uses, are accepted as aliases.

Connect with the platform, device, OS version, and app to test:

```bash
agent-device connect testingbot \
  --platform ios \
  --device "iPhone 17.*" \
  --provider-os-version "26.*" \
  --provider-app ./ZuperiOS.ipa
```

`--device` and `--provider-os-version` accept an exact value or a regular expression. Prefer a
pattern: it matches any free device in the family, so a session does not queue behind one busy
device. The pattern is anchored, so `iPhone 1` does not match `iPhone 15`. Browse the catalogue
without credentials:

```bash
curl -s https://api.testingbot.com/v1/devices
```

`--provider-app` accepts a TestingBot storage reference such as `tb://...`, an HTTP(S) app URL, or
an existing local app path. A local path is uploaded when the hosted session is created.

During `connect`, agent-device verifies the credentials first, then resolves the device selector
against the real-device catalogue, then checks the app. A `tb://` reference must still exist, must
match the session platform, and must not be a simulator-only build. A local artifact is checked for
an `.ipa` (iOS) or `.apk`/`.aab` (Android) extension. `open` still needs the app's installed bundle
or package identifier, not its upload name.

Optional labels:

```bash
--provider-build "$GITHUB_RUN_ID"
--provider-session-name "$GITHUB_JOB"
```

Optional device features:

```bash
--provider-device-orientation portrait   # or landscape        (alias --device-orientation)
--provider-geo-location DE                                   # (alias --geo-location)
--provider-timezone Europe/Brussels                          # (alias --timezone)
--provider-appium-version 3.2.0                              # (alias --appium-version)
--provider-language fr                                       # (alias --language)
--provider-locale fr_CA                                      # (alias --locale)
--provider-network-profile 3G                                # (alias --network-profile)
--provider-custom-network '{"downloadSpeed":10240,"uploadSpeed":10240,"latency":0,"loss":0}'
--provider-no-resign-app                                     # iOS only
--provider-max-duration 7200
--provider-tablet-only
```

TestingBot receives these when it creates the hosted session, split across the two capability
namespaces it reads: orientation, language, and locale are Appium-standard capabilities, while the
time zone, Appium version, geolocation, network shape, and re-signing opt-out are TestingBot's own.

- Without `--provider-appium-version`, TestingBot picks the most recent Appium version compatible
  with the requested device, OS, and version.

- The orientation applies when the session starts. An activity without a fixed orientation can
  still open in landscape. Run `agent-device orientation portrait` after launching it when needed.
- `--provider-network-profile` takes a preset: `4G`, `3G`, `Edge`, `airplane`, or `disable`. It is
  mutually exclusive with `--provider-custom-network`, which takes a JSON object with any of
  `downloadSpeed`, `uploadSpeed` (kbps), `latency` (ms), and `loss` (%).
- `--provider-geo-location` takes an ISO country code, which routes session traffic through a proxy
  in that country.
- `--provider-tablet-only` restricts allocation to tablets. Pair it with a matching selector, for
  example `--device "iPad.*"`.

## Session duration and timeouts

TestingBot's defaults assume a scripted test that never pauses, which does not fit an agent that
thinks between commands. agent-device therefore raises two of them on every session: the idle
timeout from 130 seconds to 10 minutes, and Appium's own command timeout to the same. Without this
a session is reaped mid-turn.

The maximum session duration defaults to 7200 seconds rather than TestingBot's 1800. Lower it to
cap spend, or raise it for a long run:

```bash
--provider-max-duration 3600
```

A session that reaches its maximum duration is stopped by TestingBot, not by agent-device.

## App uploads and re-signing

Upload once and reuse the reference across runs:

```bash
curl -s -u "$TESTINGBOT_KEY:$TESTINGBOT_SECRET" \
  -X POST https://api.testingbot.com/v1/storage \
  -F "file=@./ZuperiOS.ipa"
# {"app_url":"tb://<appkey>"}
```

Uploads are deleted after 62 days. A reference that has expired fails at `connect` rather than at
session creation.

TestingBot re-signs iOS apps by default, which is what lets a development build install on its
devices. Re-signing strips entitlements, so push notifications and app groups stop working. Pass
`--provider-no-resign-app` to keep the app exactly as uploaded; the build must then already be
signed for the target device.

Real iOS devices need an `.ipa`. A `.zip` is a simulator-only build and is rejected at `connect`.

## CLI workflow

```bash
export TESTINGBOT_KEY=...
export TESTINGBOT_SECRET=...

agent-device connect testingbot \
  --platform ios \
  --device "iPhone 17.*" \
  --provider-os-version "26.*" \
  --provider-app ./ZuperiOS.ipa \
  --provider-build "$GITHUB_RUN_ID"

agent-device open com.example.app
agent-device snapshot -i
agent-device click 'label="Continue"'
agent-device close
agent-device artifacts --json
agent-device disconnect
```

Android follows the same shape:

```bash
agent-device connect testingbot \
  --platform android \
  --device "Pixel.*" \
  --provider-os-version "16.*" \
  --provider-app ./app.apk
```

For MCP-only use, run `connect` in the same effective state directory before starting
`agent-device mcp`. MCP exposes `open`, `snapshot`, `click`, `close`, and `artifacts`, but not
provider `connect` commands.

## Node.js client

Use direct client configuration when the Node process manages TestingBot credentials and selectors
rather than a saved CLI connection profile:

```ts
import { createAgentDeviceClient } from 'agent-device';

const client = createAgentDeviceClient({
  leaseProvider: 'testingbot',
  platform: 'ios',
  device: 'iPhone 17.*',
  providerOsVersion: '26.*',
  providerApp: 'tb://app-key',
  providerBuild: process.env.GITHUB_RUN_ID,
});

await client.apps.open({ app: 'com.example.app' });
const snapshot = await client.capture.snapshot({ interactiveOnly: true });
console.log(snapshot.nodes.slice(0, 5));
await client.interactions.click({ selector: 'label="Continue"' });
const closed = await client.sessions.close();
const providerSessionId = closed.provider?.providerSessionId;

if (providerSessionId) {
  const artifacts = await client.sessions.artifacts({
    provider: 'testingbot',
    providerSessionId,
  });
  console.log(artifacts.cloudArtifacts);
}
```

## Artifacts and troubleshooting

After `close`, TestingBot can return the session video, Appium and device logs, screenshots, and a
dashboard link. Run `agent-device artifacts --json`, or look up a previous session explicitly:

```bash
agent-device artifacts <webdriver-session-id> --provider testingbot --json
```

The WebDriver session id is TestingBot's session id; there is no second identifier to discover.

Artifacts report `pending` with only the dashboard link until TestingBot finishes processing them,
then `ready` with the media URLs. Retry after a few seconds. The video and log URLs are signed and
valid for one hour, and screenshot URLs for seven days, so fetch them again rather than storing
them.

agent-device reports each session's outcome to TestingBot when the lease is released. A session
whose result is never reported is recorded as "unknown" in the dashboard and analytics.

TestingBot errors distinguish rejected credentials, an unmatched device selector, an expired or
mismatched `tb://` upload, and a rejected local artifact. An unmatched selector lists the closest
devices for that platform.

On hosted WebDriver sessions, `fill` checks that the field received focus before it sends keys. If
it cannot confirm focus, it fails without typing. Use `snapshot -i` to confirm the target. If the
driver cannot expose focus at all, use `press <target>` followed by `type <text>`. That sends text
without confirming the destination.
