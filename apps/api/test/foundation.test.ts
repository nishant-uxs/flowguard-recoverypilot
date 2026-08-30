import { describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadEnvironment } from '../src/env.js';

describe('M0 foundation', () => {
  it('loads safe defaults for local development', () => {
    expect(loadEnvironment({})).toMatchObject({
      NODE_ENV: 'development',
      API_PORT: 3001,
    });
  });

  it('rejects an invalid API port', () => {
    expect(() => loadEnvironment({ API_PORT: '0' })).toThrow();
  });

  it('exposes a health endpoint', async () => {
    const app = buildApp();
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: 'flowguard-api',
      status: 'ok',
      version: '0.1.0',
    });

    await app.close();
  });
});
