import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { specs } from './contracts';
import { callBroker } from './broker';
const handle = serveStdio(() => {
  const server = new McpServer({ name: 'hostframe', version: '0.1.0' }, {
    cacheHints: { 'tools/list': { ttlMs: 300000, cacheScope: 'private' } }
  });
  for (const [name, spec] of Object.entries(specs).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    server.registerTool(name, { description: spec.description, inputSchema: spec.schema }, async (args: unknown) => {
      try {
        const result = await callBroker(name, args);
        if (name === 'capture') {
          const { image, ...metadata } = result;
          return { content: [{ type: 'image' as const, data: image, mimeType: 'image/png' }, { type: 'text' as const, text: JSON.stringify(metadata) }] };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch(error) { const code=error instanceof Error&&/^[a-z_]{1,80}$/.test(error.message)?error.message:'operation_failed';return { isError: true, content: [{ type: 'text' as const, text: code+': check configuration, target and desktop connection. Credential values are never echoed.' }] }; }
    });
  }
  return server;
}, { onerror: () => { process.stderr.write('MCP transport failed.\n'); } });
process.on('SIGINT', () => { void handle.close(); });
process.on('SIGTERM', () => { void handle.close(); });
