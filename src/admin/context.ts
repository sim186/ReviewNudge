import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ConfigProvider } from '../config/effective.js';
import type { Audit } from '../db/audit.js';
import type { Repo } from '../db/repo.js';
import type { Logger } from '../logger.js';
import type { Scheduler } from '../scheduler.js';
import { page, type PageOptions, type SafeHtml } from './views/layout.js';

export interface AdminContext {
  provider: ConfigProvider;
  repo: Repo;
  audit: Audit;
  scheduler: Scheduler | null;
  logger: Logger;
}

/** Source IP for the audit trail, honouring a reverse proxy's forwarding header. */
export function sourceIp(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]!.trim();
  }
  return request.ip;
}

export interface Flash {
  kind: 'ok' | 'error';
  message: string;
}

/** Flash messages survive the POST-redirect-GET hop as query parameters. */
export function readFlash(request: FastifyRequest): Flash | null {
  const query = request.query as Record<string, string | undefined>;
  if (query.ok) return { kind: 'ok', message: query.ok };
  if (query.err) return { kind: 'error', message: query.err };
  return null;
}

export function redirectWith(reply: FastifyReply, path: string, flash: Flash): FastifyReply {
  const key = flash.kind === 'ok' ? 'ok' : 'err';
  return reply.redirect(`${path}?${key}=${encodeURIComponent(flash.message)}`, 303);
}

export function render(
  ctx: AdminContext,
  request: FastifyRequest,
  reply: FastifyReply,
  options: Omit<PageOptions, 'flash' | 'paused'>,
  body: string | SafeHtml,
): FastifyReply {
  const paused = ctx.provider.resolve().silence.enabled;
  return reply
    .type('text/html; charset=utf-8')
    .send(page({ ...options, flash: readFlash(request), paused }, body));
}

/** Trims a form field and collapses an empty string to null. */
export function formValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function formList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}
