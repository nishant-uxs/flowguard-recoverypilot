import cors from '@fastify/cors';
import Fastify from 'fastify';
import { z } from 'zod';

import { DemoController, demoScenarioSchema } from './demo.js';

export function buildApp() {
  const app = Fastify({ logger: true });
  const demo = new DemoController();

  app.register(cors, { origin: true });

  app.get('/health', async () => ({
    service: 'flowguard-api',
    status: 'ok',
    version: '0.1.0',
  }));

  app.get('/demo/state', async () => {
    await demo.ready();
    return demo.state();
  });

  app.post('/demo/scenario', async (request) => {
    const body = z.object({ scenario: demoScenarioSchema }).strict().parse(request.body);
    await demo.reset(body.scenario);
    return demo.state();
  });

  app.post('/demo/reset', async () => {
    await demo.reset('successful_recovery');
    return demo.state();
  });

  app.post<{ Params: { id: string } }>('/recovery/:id/approve', async (request, reply) => {
    try {
      await demo.approve(request.params.id, true);
      return demo.state();
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : 'unable to approve recovery',
      });
    }
  });

  app.post<{ Params: { id: string } }>('/recovery/:id/reject', async (request, reply) => {
    try {
      await demo.approve(request.params.id, false);
      return demo.state();
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : 'unable to reject recovery',
      });
    }
  });

  app.get('/audit', async () => {
    await demo.ready();
    return { events: demo.state().audit };
  });

  return app;
}
