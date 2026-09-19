import { buildApp } from './app.js';
import { ConfigurationError, loadConfig } from './config.js';

async function main() {
  const config = loadConfig();
  const app = buildApp(config);
  const shutdown = () => {
    void app.close().catch(() => {
      console.error('Server shutdown failed.');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  app.addHook('onClose', async () => {
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  });
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close();
    throw error;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof ConfigurationError ? error.message : 'Server startup failed.');
  process.exitCode = 1;
});
