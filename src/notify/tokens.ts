import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed identifiers that let a recipient act on their own notifications without an
 * account or a password.
 *
 * A token is `base64url(username).hmac`, signed with the admin session secret. It
 * carries no expiry on purpose: a link in a digest from three weeks ago should still
 * work. Rotating the secret invalidates every outstanding link at once, which is the
 * revocation mechanism.
 *
 * The capability a token grants is deliberately small — mute, un-mute, and snooze for
 * one person. It never reaches the admin panel, which keeps its own password.
 */

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function mintRecipientToken(username: string, secret: string): string {
  const payload = Buffer.from(username, 'utf8').toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

/** Returns the username when the signature checks out, otherwise null. */
export function verifyRecipientToken(token: string, secret: string): string | null {
  if (!secret) return null;

  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const supplied = token.slice(dot + 1);
  const expected = sign(payload, secret);

  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const username = Buffer.from(payload, 'base64url').toString('utf8');
  return username.length > 0 ? username : null;
}

/**
 * Base URL for links in a digest, or null when self-service should be switched off.
 *
 * Links are built from the admin bind address. A loopback or wildcard binding cannot
 * produce a URL a recipient's mail client can open, so rather than emit dead links the
 * caller is told to leave them out entirely.
 */
export function selfServiceBaseUrl(admin: {
  enabled: boolean;
  host: string;
  port: number;
}): string | null {
  if (!admin.enabled) return null;
  if (!isReachableHost(admin.host)) return null;
  return `http://${admin.host}:${admin.port}`;
}

const UNREACHABLE = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::', '']);

export function isReachableHost(host: string): boolean {
  return !UNREACHABLE.has(host.trim().toLowerCase());
}

export function muteLink(base: string, token: string, mrUrl: string): string {
  return `${base}/me/${token}/mute?mr=${encodeURIComponent(mrUrl)}`;
}

export function manageLink(base: string, token: string): string {
  return `${base}/me/${token}`;
}
