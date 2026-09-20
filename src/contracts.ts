import { z } from 'zod';
export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const recipeSchema = z.object({ path: z.string().max(2000).default('/login'), email: z.string().min(1).max(500).default('input[type=email]'), password: z.string().min(1).max(500).default('input[type=password]'), submit: z.string().min(1).max(500).default('button[type=submit]'), success: z.string().max(500).default(''), identity: z.string().max(500).default('') });
export type Recipe = z.infer<typeof recipeSchema>;
export const specs = {
  state_get: { description: 'List users, environments, account metadata and panes. Never returns credentials.', schema: z.object({}) },
  workspace_list: { description: 'List workspaces and which one is active. A workspace holds one app: its environments, users, accounts and sessions.', schema: z.object({}) },
  workspace_create: { description: 'Create an empty workspace and switch to it. Follow with environment_save, user_create, account_create and credentials_put to set it up.', schema: z.object({ name: z.string().min(1).max(80) }) },
  workspace_switch: { description: 'Switch the desktop to another workspace. Closes current panes (they are restored when switching back). Fails while a protected login is running.', schema: z.object({ workspaceId: id }) },
  workspace_rename: { description: 'Rename a workspace.', schema: z.object({ workspaceId: id, name: z.string().min(1).max(80) }) },
  workspace_delete: { description: 'Permanently delete a workspace with all of its environments, users, credentials, panes and browser sessions. confirmName must equal the workspace name exactly.', schema: z.object({ workspaceId: id, confirmName: z.string().min(1).max(80) }) },
  environment_save: { description: 'Configure an environment URL and email/password login recipe. allowedOrigins lists extra origins (e.g. a hosted auth provider) that top-level navigation may visit; credentials are still only filled on the base origin.', schema: z.object({ id, name: z.string().min(1).max(60), baseUrl: z.string().max(2000), recipe: recipeSchema, allowedOrigins: z.array(z.string().max(300)).max(20).default([]) }) },
  user_create: { description: 'Create a saved user with an optional descriptive role.', schema: z.object({ name: z.string().min(1).max(80), role: z.string().max(60).default('') }) },
  user_delete: { description: 'Delete a saved user, its account entries, stored credentials, open panes and browser sessions.', schema: z.object({ userId: id }) },
  account_delete: { description: 'Delete one account entry with its stored credentials, open panes and browser session.', schema: z.object({ accountId: id }) },
  account_create: { description: 'Create an account entry for a user in an environment. Store credentials separately.', schema: z.object({ userId: id, environmentId: id, label: z.string().min(1).max(80) }) },
  credentials_put: { description: 'Write-only create or replace an email/password pair. Values supplied here are known to the caller and may be in its transcript. Never echoes values. Use expectedRevision for overwrite.', schema: z.object({ accountId: id, temporaryId: id.optional(), email: z.string().min(1).max(320), password: z.string().min(1).max(4096), expectedRevision: z.number().int().min(0) }) },
  credentials_generate: { description: 'Generate a random password locally and store it without returning it. Does not create a website account.', schema: z.object({ accountId: id, temporaryId: id.optional(), email: z.string().min(1).max(320), expectedRevision: z.number().int().min(0) }) },
  credentials_status: { description: 'Return only configured status and revision, never any email/password fragments.', schema: z.object({ accountId: id, temporaryId: id.optional() }) },
  pane_open: { description: 'Open an account in its persistent session; additional panes share the session.', schema: z.object({ accountId: id, path: z.string().max(2000).default('/') }) },
  pane_copy: { description: 'Open another shared pane or an isolated temporary copy using credential references.', schema: z.object({ paneId: id, temporary: z.boolean() }) },
  pane_close: { description: 'Close a pane; a normal persistent session remains on disk.', schema: z.object({ paneId: id }) },
  temporary_delete: { description: 'Delete a disposable session and all of its panes and copy-owned credentials.', schema: z.object({ temporaryId: id }) },
  pane_navigate: { description: 'Navigate within the configured environment origin or an explicitly allowed extra origin.', schema: z.object({ paneId: id, path: z.string().max(2000) }) },
  auth_login: { description: 'Privately fill and submit saved credentials. Verification requires configured success and identity selectors. Never returns values.', schema: z.object({ paneId: id }) },
  page_snapshot: { description: 'Return bounded visible text and interactive element metadata, excluding forms and secret values. No arbitrary JavaScript.', schema: z.object({ paneId: id }) },
  page_click: { description: 'Click a CSS selector on the page. Cannot operate login forms through this tool.', schema: z.object({ paneId: id, selector: z.string().min(1).max(500) }) },
  page_fill: { description: 'Fill an ordinary non-login text field. Use auth_login for stored credentials.', schema: z.object({ paneId: id, selector: z.string().min(1).max(500), text: z.string().max(10000) }) },
  page_wait: { description: 'Wait for a visible CSS selector.', schema: z.object({ paneId: id, selector: z.string().min(1).max(500), timeoutMs: z.number().int().min(100).max(15000).default(5000) }) },
  capture: { description: 'Capture a visible pane as PNG, masking form fields. Returns image content through MCP.', schema: z.object({ paneId: id }) },
} as const;
export type Command = keyof typeof specs;
export type Environment = { id: string; name: string; baseUrl: string; recipe: Recipe; demo?: boolean; allowedOrigins?: string[] };
export type User = { id: string; name: string; role: string };
export type Account = { id: string; userId: string; environmentId: string; label: string };
export type Split = { type: 'leaf'; paneId: string } | { type: 'split'; direction: 'row' | 'column'; ratio: number; first: Split; second: Split };
export type State = { version: 1; users: User[]; environments: Environment[]; accounts: Account[]; layout: Split | null };
export type Pane = { id: string; accountId: string; temporaryId?: string; sessionKey: string; url: string; title: string; busy: boolean; visible: boolean; devtools: boolean; blocked?: string; loadError?: string };
export class AppError extends Error { constructor(public code: string) { super(code); } }
export function requireValue<T>(value: T | undefined | null, code = 'not_found'): T { if (value == null) throw new AppError(code); return value; }
export function allowedUrl(path: string, base: string, extraOrigins: string[] = []): string {
  try { const root = new URL(base); const target = new URL(path, root); if (!['http:', 'https:'].includes(root.protocol) || !['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw 0; if (target.origin !== root.origin && !extraOrigins.includes(target.origin)) throw 0; return target.href; } catch { throw new AppError('origin_not_allowed'); }
}
export function normalizeOrigins(values: string[]): string[] { const out: string[] = []; for (const v of values) { const t = v.trim(); if (!t) continue; let origin = ''; try { const u = new URL(t.includes('://') ? t : 'https://' + t); if (['http:', 'https:'].includes(u.protocol)) origin = u.origin; } catch {} if (!origin) throw new AppError('invalid_origin'); if (!out.includes(origin)) out.push(origin); } return out; }
export function sessionKey(accountId: string, temporaryId?: string) { return temporaryId ? `temporary-${temporaryId}` : `persist:account-${accountId}`; }
