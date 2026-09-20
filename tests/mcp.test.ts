import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { specs } from '../src/contracts';

// Exercise the built adapter with a private broker, never the user's desktop.
test('MCP modern wire protocol and legacy compatibility preserve tool contracts', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hostframe-mcp-'));
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\hostframe-test-${randomUUID()}` : join(directory, 'broker.sock');
  const token = randomUUID();
  const calls: Array<{ command: string; params: any }> = [];
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const broker = createServer(socket => {
    let input = '';
    socket.on('data', chunk => {
      input += chunk.toString();
      if (!input.includes('\n')) return;
      const request = JSON.parse(input.slice(0, input.indexOf('\n')));
      assert.equal(request.token, token);
      calls.push(request);
      if (request.command === 'page_click') {
        socket.end(JSON.stringify({ ok: false, error: 'private@example.test secret-password' }) + '\n');
        return;
      }
      const result = request.command === 'capture' ? { image: png, paneId: 'pane-1' }
        : request.command === 'credentials_status' ? { configured: true, revision: 1 }
        : { received: request.params };
      socket.end(JSON.stringify({ ok: true, result }) + '\n');
    });
  });
  try {
    await mkdir(join(directory, 'Roleframe'));
    await writeFile(join(directory, 'Roleframe', 'agent-connection.json'), JSON.stringify({ pipe, token }));
    await new Promise<void>((resolve, reject) => { broker.once('error', reject); broker.listen(pipe, resolve); });
    for (const modern of [true, false]) {
      const client = new Client({ name: 'hostframe-test', version: '1.0.0' }, {
        versionNegotiation: { mode: modern ? { pin: '2026-07-28' } : 'legacy' }
      });
      const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/mcp.cjs')], env: { APPDATA: directory }, stderr: 'pipe' });
      const sent: any[] = [];
      const received: any[] = [];
      const send = transport.send.bind(transport);
      transport.send = async message => { sent.push(message); return send(message); };
      try {
        await client.connect(transport);
        assert.equal(client.getProtocolEra(), modern ? 'modern' : 'legacy');
        assert.equal(client.getNegotiatedProtocolVersion(), modern ? '2026-07-28' : '2025-11-25');
        assert.equal(sent.some(message => message.method === 'initialize'), !modern);
        const onmessage = transport.onmessage!;
        transport.onmessage = message => { received.push(message); onmessage(message); };
        const listed = await client.listTools();
        assert.deepEqual(listed.tools.map(tool => tool.name), Object.keys(specs).sort());
        if (modern) {
          const wire = received.find(message => message.result?.tools)?.result;
          assert.equal(wire.ttlMs, 300000);
          assert.equal(wire.cacheScope, 'private');
          assert.equal(wire.resultType, 'complete');
        }
        const before = calls.length;
        const invalid = await client.callTool({ name: 'credentials_put', arguments: { accountId: 'account-1' } });
        assert.equal(invalid.isError, true);
        assert.equal(calls.length, before, 'Invalid arguments must not reach the broker');
        const waited = await client.callTool({ name: 'page_wait', arguments: { paneId: 'pane-1', selector: '#ready' } });
        assert.ok(!waited.isError);
        assert.equal(calls.at(-1)!.params.timeoutMs, 5000, 'Schema defaults still apply');
        const status = await client.callTool({ name: 'credentials_status', arguments: { accountId: 'account-1' } });
        assert.deepEqual(status.content, [{ type: 'text', text: '{"configured":true,"revision":1}' }]);
        const capture = await client.callTool({ name: 'capture', arguments: { paneId: 'pane-1' } });
        assert.deepEqual(capture.content, [{ type: 'image', data: png, mimeType: 'image/png' }, { type: 'text', text: '{"paneId":"pane-1"}' }]);
        const failed = await client.callTool({ name: 'page_click', arguments: { paneId: 'pane-1', selector: '#button' } });
        assert.equal(failed.isError, true);
        assert.ok(!JSON.stringify(failed).includes('secret-password'));
        assert.ok(!JSON.stringify(failed).includes('private@example.test'));
      } finally { await client.close(); }
    }
  } finally {
    await new Promise<void>(resolve => broker.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
