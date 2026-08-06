import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'mra_session';

/** Constant-time comparison that also tolerates differing lengths. */
export function passwordMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (b.length === 0) return false;
  // Compare hashes of equal length so the check does not leak the password length.
  const padded = Buffer.alloc(Math.max(a.length, b.length));
  const other = Buffer.alloc(padded.length);
  a.copy(padded);
  b.copy(other);
  return timingSafeEqual(padded, other) && a.length === b.length;
}

export function generateSessionSecret(): string {
  return randomBytes(32).toString('hex');
}

export interface SessionOptions {
  ttlHours: number;
}

export function issueSession(reply: FastifyReply, options: SessionOptions): void {
  reply.setCookie(SESSION_COOKIE, String(Date.now()), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    signed: true,
    maxAge: options.ttlHours * 3600,
  });
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** True when the request carries a valid, unexpired, correctly signed session. */
export function hasValidSession(request: FastifyRequest, options: SessionOptions): boolean {
  const cookie = request.cookies[SESSION_COOKIE];
  if (!cookie) return false;

  const unsigned = request.unsignCookie(cookie);
  if (!unsigned.valid || !unsigned.value) return false;

  const issuedAt = Number(unsigned.value);
  if (!Number.isFinite(issuedAt)) return false;

  return Date.now() - issuedAt < options.ttlHours * 3_600_000;
}

/** Paths reachable without a session. */
export const PUBLIC_PATHS = new Set(['/login', '/static/style.css', '/healthz']);
