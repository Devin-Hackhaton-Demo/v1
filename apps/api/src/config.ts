import * as z from 'zod';

const configSchema = z.object({
  HOST: z.literal('127.0.0.1').default('127.0.0.1'),
  PORT: z.string().regex(/^\d+$/).default('3000').transform(Number).pipe(z.int().min(1).max(65535)),
  NODE_ENV: z.enum(['development', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export class ConfigurationError extends Error {}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const result = configSchema.safeParse({
    HOST: environment.HOST,
    PORT: environment.PORT,
    NODE_ENV: environment.NODE_ENV,
    LOG_LEVEL: environment.LOG_LEVEL,
  });
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path[0]))];
    throw new ConfigurationError(`Invalid server configuration: ${fields.join(', ')}`);
  }
  return {
    host: result.data.HOST,
    port: result.data.PORT,
    environment: result.data.NODE_ENV,
    logLevel: result.data.LOG_LEVEL,
  };
}

export type Config = ReturnType<typeof loadConfig>;
