import cors from '@fastify/cors';
import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify({ logger: true });

  app.register(cors, { origin: true });

  app.get('/health', async () => ({
    service: 'flowguard-api',
    status: 'ok',
    version: '0.1.0',
  }));

  return app;
}
