import type { DeviceLease } from '@agent-device/contracts/device';
import { AppError, errorMessage } from '@agent-device/kernel/errors';

export type LeaseValue<T> = T | ((lease: DeviceLease) => T);

/** Best-effort release after a failure; a failed release rides along as `cleanupError`, never masks the primary. */
export async function releaseOnFailure(
  primaryError: unknown,
  release: () => Promise<unknown> | undefined,
): Promise<void> {
  try {
    await release();
  } catch (cleanupError) {
    if (primaryError instanceof AppError) {
      primaryError.details = { ...primaryError.details, cleanupError: errorMessage(cleanupError) };
    }
  }
}

export function resolveLeaseValue<T>(
  value: LeaseValue<T> | undefined,
  lease: DeviceLease,
): T | undefined {
  return typeof value === 'function' ? (value as (lease: DeviceLease) => T)(lease) : value;
}

/**
 * POSTs an app binary as a multipart `file` part.
 *
 * Shared because the upload itself is the same everywhere — read, wrap, post, honour the abort —
 * and only the endpoint, auth header, and response shape are the provider's. An upload is not a
 * billed resource, so the request's cancellation may abort it, unlike the session it precedes.
 */
export async function postProviderAppUpload(options: {
  appPath: string;
  endpoint: string | URL;
  headers: Record<string, string>;
  signal?: AbortSignal;
}): Promise<Response> {
  options.signal?.throwIfAborted();
  const { default: fs } = await import('node:fs/promises');
  const { default: path } = await import('node:path');
  const file = await fs.readFile(options.appPath);
  const form = new FormData();
  form.set('file', new Blob([file]), path.basename(options.appPath));
  return await fetch(options.endpoint, {
    method: 'POST',
    headers: options.headers,
    body: form,
    signal: options.signal,
  });
}

export function basicAuthHeader(credentials: { username: string; accessKey: string }): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.accessKey}`).toString('base64')}`;
}

export function trimLeadingSlash(value: string): string {
  let firstNonSlash = 0;
  while (firstNonSlash < value.length && value.charCodeAt(firstNonSlash) === 47) {
    firstNonSlash += 1;
  }
  return firstNonSlash === 0 ? value : value.slice(firstNonSlash);
}

export function trimTrailingSlash(value: string): string {
  let lastNonSlash = value.length - 1;
  while (lastNonSlash >= 0 && value.charCodeAt(lastNonSlash) === 47) {
    lastNonSlash -= 1;
  }
  return lastNonSlash === value.length - 1 ? value : value.slice(0, lastNonSlash + 1);
}

export function withTrailingSlash(url: URL): URL {
  if (url.pathname.endsWith('/')) return url;
  const copy = new URL(url);
  copy.pathname = `${copy.pathname}/`;
  return copy;
}
