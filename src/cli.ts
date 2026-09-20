import { callBroker } from './broker';
import { specs } from './contracts';
async function run() {
  const command = process.argv[2];
  if (!command || command === '--help') { process.stdout.write('Hostframe CLI: node dist/cli.cjs <command> [JSON | --stdin]\n'+Object.keys(specs).join('\n')+'\nUse --stdin for credentials; do not put passwords in command arguments.\n'); return; }
  if (['credentials_put','credentials_generate'].includes(command) && process.argv[3] !== '--stdin') throw new Error('credentials_require_stdin');
  let raw = process.argv[3] || '{}';
  if (raw === '--stdin') { raw = ''; for await (const chunk of process.stdin) raw += chunk; }
  const result = await callBroker(command, JSON.parse(raw)); process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
run().catch(() => { process.stderr.write('Command failed. Check command, input and desktop connection. No input was echoed.\n'); process.exitCode = 1; });
