import { McpServer } from '@modelcontextprotocol/server';
import {
  SCHEMA_VERSION,
  SERVER_INFO,
  serverInfoInputSchema,
  serverInfoResponseSchema,
} from '@demo/contracts';

export function buildMcpServer(requestId: string) {
  const server = new McpServer({ name: SERVER_INFO.name, version: SERVER_INFO.version });
  server.registerTool('server_info', {
    title: 'Local server diagnostics',
    description: 'Report the local MCP scaffold identity. No context storage or business operations are available.',
    inputSchema: serverInfoInputSchema,
    outputSchema: serverInfoResponseSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async () => ({
    content: [{ type: 'text', text: 'The local MCP scaffold is running. Business tools are not implemented.' }],
    structuredContent: serverInfoResponseSchema.parse({
      schema_version: SCHEMA_VERSION,
      request_id: requestId,
      ok: true,
      data: SERVER_INFO,
    }),
  }));
  return server;
}
