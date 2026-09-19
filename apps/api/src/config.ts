import * as z from 'zod';

const configSchema = z.object({
  HOST: z.literal('127.0.0.1').default('127.0.0.1'),
  PORT: z.string().regex(/^\d+$/).default('3000').transform(Number).pipe(z.int().min(1).max(65535)),
  NODE_ENV: z.enum(['development', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-5'),
  APP_ORIGIN: z.url().optional(),
  SUPABASE_URL: z.url().optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
});

export class ConfigurationError extends Error {}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const result = configSchema.safeParse({
    HOST: environment.HOST,
    PORT: environment.PORT,
    NODE_ENV: environment.NODE_ENV,
    LOG_LEVEL: environment.LOG_LEVEL,
    ANTHROPIC_API_KEY: environment.ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL: environment.ANTHROPIC_MODEL,
    APP_ORIGIN: environment.APP_ORIGIN,
    SUPABASE_URL: environment.SUPABASE_URL,
    SUPABASE_ANON_KEY: environment.SUPABASE_ANON_KEY,
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
    ...([result.data.APP_ORIGIN, result.data.SUPABASE_URL, result.data.SUPABASE_ANON_KEY].every((value) => value === undefined) ? {} : {
      appOrigin: result.data.APP_ORIGIN ?? `http://${result.data.HOST}:${result.data.PORT}`,
    }),
    ...(result.data.SUPABASE_URL === undefined ? {} : { supabaseUrl: result.data.SUPABASE_URL }),
    ...(result.data.SUPABASE_ANON_KEY === undefined ? {} : { supabaseAnonKey: result.data.SUPABASE_ANON_KEY }),
    ...(result.data.ANTHROPIC_API_KEY === undefined ? {} : {
      anthropicApiKey: result.data.ANTHROPIC_API_KEY,
      anthropicModel: result.data.ANTHROPIC_MODEL,
    }),
  };
}

export type Config = ReturnType<typeof loadConfig>;
