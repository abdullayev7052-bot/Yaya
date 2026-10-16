import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import mobileRoutes from './routes/mobile.js';
import adminRoutes from './routes/admin.js';
import publicRoutes from './routes/public.js';

const ADMIN_DIR = fileURLToPath(new URL('../../admin', import.meta.url));
// Web build of the collector app (same code as the APK), used to test from a laptop.
const WEBAPP_DIR = process.env.WEBAPP_DIR ?? fileURLToPath(new URL('../../mobile/dist', import.meta.url));

export function buildApp({ db, jwtSecret, logger = false }) {
  // Behind Railway's proxy: trust it so login rate limiting sees real client IPs.
  const app = Fastify({ logger, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });
  app.register(fastifyJwt, { secret: jwtSecret });

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    // The panel embeds the web app in an iframe from the same origin; nobody else may.
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    if (req.url.startsWith('/api/') && !req.url.startsWith('/api/public/logo')) reply.header('Cache-Control', 'no-store');
  });

  app.get('/health', async () => ({ ok: true }));
  app.register(mobileRoutes, { prefix: '/api/mobile', db });
  app.register(adminRoutes, { prefix: '/api/admin', db });
  app.register(publicRoutes, { prefix: '/api/public', db });
  app.register(fastifyStatic, { root: ADMIN_DIR, prefix: '/admin/' });
  if (existsSync(WEBAPP_DIR)) {
    app.register(fastifyStatic, { root: WEBAPP_DIR, prefix: '/app/', decorateReply: false });
  }
  app.get('/', (_req, reply) => reply.redirect('/admin/'));
  return app;
}
