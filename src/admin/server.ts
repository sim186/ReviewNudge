import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger as rootLogger } from '../logger.js';
import {
  PUBLIC_PATHS,
  clearSession,
  generateSessionSecret,
  hasValidSession,
  issueSession,
  passwordMatches,
} from './auth.js';
import { type AdminContext, sourceIp } from './context.js';
import { registerAudit } from './routes/audit.js';
import { registerDashboard } from './routes/dashboard.js';
import { registerExclusions } from './routes/exclusions.js';
import { registerPending } from './routes/pending.js';
import { registerProjects } from './routes/projects.js';
import { registerRecipients } from './routes/recipients.js';
import { registerSettings } from './routes/settings.js';
import { registerSelfService } from './routes/selfservice.js';
import { registerSilence } from './routes/silence.js';
import { loginPage } from './views/layout.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface AdminServerOptions {
  host: string;
  port: number;
  password: string;
  sessionSecret: string;
  sessionTtlHours: number;
}

export function buildAdminServer(ctx: AdminContext, options: AdminServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: true });
  const sessionOptions = { ttlHours: options.sessionTtlHours };

  app.register(cookie, { secret: options.sessionSecret || generateSessionSecret() });
  app.register(formbody);
  app.register(fastifyStatic, { root: resolve(here, 'public'), prefix: '/static/' });

  // Everything except the login form, the stylesheet and the recipient self-service
  // routes needs a session. `/me/*` carries its own signed token instead.
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]!;
    if (PUBLIC_PATHS.has(path) || path.startsWith('/static/') || path.startsWith('/me/')) return;
    if (hasValidSession(request, sessionOptions)) return;

    if (request.method === 'GET') {
      return reply.type('text/html; charset=utf-8').status(401).send(loginPage());
    }
    return reply.status(401).send('Sign in first.');
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/login', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(loginPage()),
  );

  app.post('/login', async (request, reply) => {
    const supplied = (request.body as Record<string, string>)?.password ?? '';

    if (!passwordMatches(supplied, options.password)) {
      ctx.audit.record({
        actor: 'admin',
        sourceIp: sourceIp(request),
        action: 'auth.login',
        outcome: 'error',
        detail: 'wrong password',
      });
      ctx.logger.warn({ ip: sourceIp(request) }, 'failed admin login');
      return reply
        .type('text/html; charset=utf-8')
        .status(401)
        .send(loginPage('That password is not right.'));
    }

    issueSession(reply, sessionOptions);
    ctx.audit.record({ actor: 'admin', sourceIp: sourceIp(request), action: 'auth.login' });
    return reply.redirect('/', 303);
  });

  app.post('/logout', async (request, reply) => {
    clearSession(reply);
    ctx.audit.record({ actor: 'admin', sourceIp: sourceIp(request), action: 'auth.logout' });
    return reply.redirect('/login', 303);
  });

  registerDashboard(app, ctx);
  registerPending(app, ctx);
  registerProjects(app, ctx);
  registerRecipients(app, ctx);
  registerExclusions(app, ctx);
  registerSilence(app, ctx);
  registerAudit(app, ctx);
  registerSettings(app, ctx);
  registerSelfService(app, ctx, { secret: options.sessionSecret });

  app.setErrorHandler(async (error: unknown, request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.error({ err: message, url: request.url }, 'admin request failed');
    return reply.status(500).type('text/plain').send(`Something went wrong: ${message}`);
  });

  return app;
}

export async function startAdminServer(
  ctx: AdminContext,
  options: AdminServerOptions,
): Promise<FastifyInstance> {
  const app = buildAdminServer(ctx, options);
  await app.listen({ host: options.host, port: options.port });

  const log = ctx.logger ?? rootLogger;
  log.info(
    { url: `http://${options.host}:${options.port}` },
    options.host === '127.0.0.1'
      ? 'admin panel listening on loopback only'
      : 'admin panel listening — make sure it is behind a reverse proxy',
  );
  return app;
}
