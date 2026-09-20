import { createServer, connect, Server } from 'node:net';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { AppError } from './contracts';
// Keep the original discovery path and pipe identity compatible across the Hostframe rebrand.
export const discoveryDirectory = () => join(process.env.APPDATA || join(homedir(), '.config'), 'Roleframe');
export const discoveryFile = () => join(discoveryDirectory(), 'agent-connection.json');
export async function startBroker(dispatch: (command: string, params: unknown) => Promise<unknown>) {
  mkdirSync(discoveryDirectory(), { recursive: true });
  const suffix = createHash('sha256').update(homedir()).digest('hex').slice(0,16);
  const separator = String.fromCharCode(92);
  const pipe = platform() === 'win32' ? [separator + separator + '.', 'pipe', `roleframe-${suffix}`].join(separator) : join(tmpdir(), `roleframe-${suffix}.sock`);
  const token = randomBytes(32).toString('hex');
  const server = createServer(socket => {
    socket.setTimeout(60000, () => socket.destroy());
    let input = ''; let handled = false;
    socket.on('error', () => {});
    socket.on('data', async chunk => {
      if (handled) return; input += chunk.toString(); if (input.length > 256000) { socket.destroy(); return; }
      if (!input.includes('\n')) return; handled = true;
      try {
        const msg = JSON.parse(input.slice(0,input.indexOf('\n')));
        const candidate = Buffer.from(typeof msg.token === 'string' ? msg.token : ''); const expected = Buffer.from(token);
        if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) throw new AppError('unauthorized');
        const result = await dispatch(msg.command, msg.params);
        socket.end(JSON.stringify({ ok: true, result }) + '\n');
      } catch (e) { socket.end(JSON.stringify({ ok: false, error: e instanceof AppError ? e.code : 'operation_failed' }) + '\n'); }
    });
  });
  await new Promise<void>((resolve,reject) => { server.once('error',reject); server.listen(pipe, resolve); });
  writeFileSync(discoveryFile(), JSON.stringify({ pipe, token }), { mode: 0o600 });
  return { server, close: () => { server.close(); rmSync(discoveryFile(), { force: true }); } };
}
export async function callBroker(command: string, params: unknown) {
  const config = JSON.parse(readFileSync(discoveryFile(),'utf8'));
  return new Promise<any>((resolve,reject) => {
    const socket = connect(config.pipe); let data = '';
    socket.setTimeout(60000, () => { socket.destroy(); reject(new Error('broker_timeout')); });
    socket.on('connect', () => socket.write(JSON.stringify({ token: config.token, command, params })+'\n'));
    socket.on('data', chunk => { data += chunk.toString(); if (data.length > 30000000) { socket.destroy(); reject(new Error('response_too_large')); } });
    socket.on('error', () => reject(new Error('desktop_unavailable')));
    socket.on('end', () => { try { const result = JSON.parse(data); result.ok ? resolve(result.result) : reject(new Error(result.error)); } catch { reject(new Error('invalid_response')); } });
  });
}
