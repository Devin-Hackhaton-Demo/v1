import * as z from 'zod';

export const SCHEMA_VERSION = 1;
export const SERVER_INFO = {
  name: 'context-mcp-server',
  version: '0.1.0',
  mode: 'local',
} as const;

export const errorCodeSchema = z.enum([
  'UNAUTHENTICATED', 'NOT_FOUND', 'FORBIDDEN', 'VALIDATION_ERROR',
  'REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'CONTEXT_INCOMPLETE',
  'DECISION_CONFLICT', 'APPROVAL_REQUIRED', 'APPROVAL_EXPIRED',
  'INVALID_STATE', 'LEASE_EXPIRED', 'FILE_UNAVAILABLE', 'LIMIT_EXCEEDED',
  'SECRET_DETECTED', 'PROVIDER_ERROR', 'OUTCOME_UNKNOWN',
]);

export const errorSchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string().min(1),
  retryable: z.boolean(),
});

export function createResponseSchema<T extends z.ZodType>(data: T) {
  const common = { schema_version: z.literal(SCHEMA_VERSION), request_id: z.uuid() };
  return z.discriminatedUnion('ok', [
    z.strictObject({ ...common, ok: z.literal(true), data }),
    z.strictObject({ ...common, ok: z.literal(false), error: errorSchema }),
  ]);
}

export const serverInfoInputSchema = z.strictObject({});
export const serverInfoSchema = z.strictObject({
  name: z.literal(SERVER_INFO.name),
  version: z.literal(SERVER_INFO.version),
  mode: z.literal(SERVER_INFO.mode),
});
export const serverInfoResponseSchema = createResponseSchema(serverInfoSchema);

export const chatMessageSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(65_536),
});
export const chatRequestSchema = z.strictObject({
  messages: z.array(chatMessageSchema).min(1).max(40),
  system: z.string().max(8_192).optional(),
});
export const chatDataSchema = z.strictObject({
  reply: z.string(),
  model: z.string(),
  usage: z.strictObject({
    input_tokens: z.int().nonnegative(),
    output_tokens: z.int().nonnegative(),
  }),
});
export const chatResponseSchema = createResponseSchema(chatDataSchema);

export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ServiceError = z.infer<typeof errorSchema>;
export type ServerInfoResponse = z.infer<typeof serverInfoResponseSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ChatData = z.infer<typeof chatDataSchema>;
export type ChatResponse = z.infer<typeof chatResponseSchema>;
