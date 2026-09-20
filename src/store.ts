import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, State } from './contracts';
export const uid = () => randomUUID();
export function atomicJson(path: string, value: unknown) { const tmp = path + '.tmp'; writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); renameSync(tmp, path); }
export class Store {
  state: State;
  constructor(public directory: string) {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'workspace.json');
    if (existsSync(path)) { this.state = JSON.parse(readFileSync(path, 'utf8')); if (this.state.version !== 1 || !Array.isArray(this.state.accounts)) throw new AppError('unsupported_workspace'); }
    else this.state = { version: 1, users: [], environments: [], accounts: [], layout: null };
  }
  save() { atomicJson(join(this.directory, 'workspace.json'), this.state); }
}
type Secret = { email: string; password: string };
type Entry = { encrypted: string; revision: number };
export class Vault {
  private entries: Record<string, Entry> = {};
  private temporary = new Map<string, { value: Secret; revision: number }>();
  constructor(private directory: string, private encrypt: (value: string) => Buffer, private decrypt: (value: Buffer) => string) {
    const path = join(directory, 'vault.json');
    if (existsSync(path)) this.entries = JSON.parse(readFileSync(path, 'utf8'));
  }
  private key(accountId: string, temp?: string) { return temp ? `${temp}:${accountId}` : accountId; }
  status(accountId: string, temp?: string) {
    const own = temp ? this.temporary.get(this.key(accountId, temp)) : undefined;
    const entry = own || this.entries[accountId];
    return { credentialRef: `cred:${this.key(accountId, temp)}`, configured: !!entry, revision: entry?.revision || 0, inherited: !!temp && !own && !!entry, verification: 'unverified' };
  }
  put(accountId: string, value: Secret, expectedRevision: number, temp?: string) {
    if (this.status(accountId, temp).revision !== expectedRevision) throw new AppError('revision_conflict');
    const revision = expectedRevision + 1;
    if (temp) this.temporary.set(this.key(accountId, temp), { value: { ...value }, revision });
    else {
      const entry = { encrypted: this.encrypt(JSON.stringify(value)).toString('base64'), revision };
      const next = { ...this.entries, [accountId]: entry };
      atomicJson(join(this.directory, 'vault.json'), next); this.entries = next;
    }
    return this.status(accountId, temp);
  }
  // Main-process-only: never exposed through IPC, CLI or MCP.
  use(accountId: string, temp?: string): Secret {
    const own = temp ? this.temporary.get(this.key(accountId, temp)) : undefined;
    if (own) return { ...own.value };
    const entry = this.entries[accountId]; if (!entry) throw new AppError('credentials_not_configured');
    return JSON.parse(this.decrypt(Buffer.from(entry.encrypted, 'base64')));
  }
  remove(accountId: string) { if (!(accountId in this.entries)) return; const next = { ...this.entries }; delete next[accountId]; atomicJson(join(this.directory, 'vault.json'), next); this.entries = next; }
  removeTemporary(temp: string) { for (const key of this.temporary.keys()) if (key.startsWith(temp + ':')) this.temporary.delete(key); }
}
