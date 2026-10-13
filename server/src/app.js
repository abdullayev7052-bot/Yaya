import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import mobileRoutes from './routes/mobile.js';
import adminRoutes from './routes/admin.js';

export function buildApp({ db, jwtSecret, logger = false }) {
  const app = Fastify({ logger });
  app.register(fastifyJwt, { secret: jwtSecret });
  app.get('/health', async () => ({ ok: true }));
  app.register(mobileRoutes, { prefix: '/api/mobile', db });
  app.register(adminRoutes, { prefix: '/api/admin', db });
  return app;
}
