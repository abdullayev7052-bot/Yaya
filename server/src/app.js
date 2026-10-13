import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import mobileRoutes from './routes/mobile.js';
import adminRoutes from './routes/admin.js';
import { createBitoClient } from './bito/client.js';

const ADMIN_DIR = fileURLToPath(new URL('../../admin', import.meta.url));

export function buildApp({ db, jwtSecret, bito = createBitoClient({}), logger = false }) {
  const app = Fastify({ logger });
  app.register(fastifyJwt, { secret: jwtSecret });
  app.get('/health', async () => ({ ok: true }));
  app.register(mobileRoutes, { prefix: '/api/mobile', db });
  app.register(adminRoutes, { prefix: '/api/admin', db, bito });
  app.register(fastifyStatic, { root: ADMIN_DIR, prefix: '/admin/' });
  app.get('/', (_req, reply) => reply.redirect('/admin/'));
  return app;
}
