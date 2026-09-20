import { spawn } from 'node:child_process';
import electron from 'electron';
// Some development hosts set this for their own runtime. Clear it only for our child.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: process.argv.includes('--smoke-test') });
child.on('error', () => { process.stderr.write('Unable to launch Electron.\n'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
