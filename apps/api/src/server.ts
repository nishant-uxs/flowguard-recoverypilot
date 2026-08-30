import { buildApp } from './app.js';
import { loadEnvironment } from './env.js';

const environment = loadEnvironment();
const app = buildApp();

try {
  await app.listen({ host: '0.0.0.0', port: environment.API_PORT });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
