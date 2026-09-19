import type { IncomingMessage, ServerResponse } from 'node:http';

export type AuthUser = { id: string; email: string; displayName?: string };
export type AuthOptions = {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof globalThis.fetch;
};
export type AuthContext = { user: AuthUser | null; csrfToken: string };
export function getAuthContext(request: IncomingMessage, response: ServerResponse, options?: AuthOptions): Promise<AuthContext>;
export function requireAuth(request: IncomingMessage, response: ServerResponse, options?: AuthOptions): Promise<AuthUser | null>;
export function requireAiConsent(request: IncomingMessage, response: ServerResponse, options?: AuthOptions): Promise<AuthUser | null>;
export function handleAuthRequest(request: IncomingMessage, response: ServerResponse, options?: AuthOptions): Promise<void>;
