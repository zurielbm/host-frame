import { z } from 'zod';
export const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const recipeSchema = z.object({ path: z.string().max(2000).default('/login'), email: z.string().min(1).max(500).default('input[type=email]'), password: z.string().min(1).max(500).default('input[type=password]'), submit: z.string().min(1).max(500).default('button[type=submit]'), success: z.string().max(500).default(''), identity: z.string().max(500).default('') });
export type Recipe = z.infer<typeof recipeSchema>;
// How an app picks its UI language beyond Accept-Language and the browser locale, which replay always sets.
export const languageSchema = z.object({ cookie: z.string().max(200).default(''), storageKey: z.string().max(200).default(''), pathPrefix: z.boolean().default(false) });
export type LanguageRecipe = z.infer<typeof languageSchema>;
export const lang = z.string().regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/);
const selectors = z.array(z.string().min(1).max(500)).min(1).max(4);
export const stepSchema = z.object({
  id,
  kind: z.enum(['navigate', 'click', 'type', 'select', 'check', 'key', 'scroll', 'login', 'dismiss']),
  delayMs: z.number().int().min(0).max(60000),
  label: z.string().max(120).default(''),
  selectors: selectors.optional(),
  fragile: z.boolean().default(false),
  path: z.string().max(2000).optional(),
  text: z.string().max(10000).optional(),
  texts: z.record(lang, z.string().max(10000)).default({}),
  value: z.string().max(500).optional(),
  checked: z.boolean().optional(),
  key: z.enum(['Enter', 'Escape']).optional(),
  scroll: z.number().min(0).max(1).optional(),
  mobileSkip: z.boolean().default(false),
  mobilePre: z.array(selectors).max(4).default([]),
  /** A click on something that doesn't look clickable (often a click to dismiss focus). Replay skips it if it can't be found. */
  optional: z.boolean().default(false),
  /** Where inside the element an optional click landed, as fractions of its width and height. */
  at: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
  /** What was clicked while recording, for debugging. Display only. */
  target: z.object({ tag: z.string().max(40), html: z.string().max(300), text: z.string().max(120), dialog: z.string().max(80), pos: z.string().max(60) }).partial().optional(),
});
export type Step = z.infer<typeof stepSchema>;
export const devices = {
  iphone: { name: 'iPhone 15', width: 393, height: 852, scale: 3, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', platform: 'iPhone' },
  pixel: { name: 'Pixel 8', width: 412, height: 915, scale: 2.625, userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36', platform: 'Android' },
} as const;
export const recordingSchema = z.object({
  id, name: z.string().min(1).max(80), environmentId: id, accountId: id,
  recordedLang: lang.default('en'), replayLang: lang.default('es'),
  speed: z.number().min(0.25).max(4).default(1), typing: z.enum(['human', 'instant']).default('human'),
  cursor: z.boolean().default(true), device: z.enum(['iphone', 'pixel']).default('iphone'),
  createdAt: z.string().max(40), steps: z.array(stepSchema).max(500),
});
export type Recording = z.infer<typeof recordingSchema>;
/** Recorded pauses become step delays; very short or long thinking pauses would make a poor demo. */
export const clampDelay = (ms: number) => Math.round(Math.min(3000, Math.max(300, ms)));
export const scaledDelay = (ms: number, speed: number) => Math.round(ms / Math.min(4, Math.max(0.25, speed || 1)));
/** Swap a leading language segment (/en/jobs, /en-US/jobs) for the replay language. */
export function localizePath(path: string, from: string, to: string) {
  const [pathname, rest = ''] = path.split(/(?=[?#])/, 2) as [string, string?];
  const parts = pathname.split('/');
  const first = (parts[1] || '').toLowerCase(), base = from.toLowerCase().split('-')[0];
  if (first && (first === from.toLowerCase() || first.split('-')[0] === base)) parts[1] = to;
  return parts.join('/') + path.slice(pathname.length);
}
/** CSS-escaped link selectors carry the recorded language path; point them at the replay language. */
export function localizeSelector(selector: string, from: string, to: string) {
  const m = /^a\[href="((?:[^"\\]|\\.)*)"\]$/.exec(selector); if (!m) return selector;
  const href = localizePath(m[1].replace(/\\(.)/g, '$1'), from, to);
  return `a[href="${href.replace(/["\\]/g, '\\$&')}"]`;
}
/** Framework-generated ids (React useId in all its formats, Radix, Headless UI, hashes) change between renders and languages. */
export const GENERATED_ID = /^(.*(:r[0-9a-z]+:|«r[0-9a-z]+»|_r_[0-9a-z]+_)|radix-|headlessui-|mui-|react-|ember\d|[0-9]|.*[0-9a-f]{8,}|.*\d{4,})/i;
export function isLoginUrl(url: string, baseUrl: string, loginPath: string) {
  const path = new URL(url).pathname;
  const root = new URL(loginPath,baseUrl).pathname.replace(/\/+$/, '') || '/';
  return path === root || (root !== '/' && path.startsWith(root + '/'));
}
export const specs = {
  state_get: { description: 'List users, environments, account metadata and panes. Never returns credentials.', schema: z.object({}) },
  workspace_list: { description: 'List workspaces and which one is active. A workspace holds one app: its environments, users, accounts and sessions.', schema: z.object({}) },
  workspace_create: { description: 'Create an empty workspace and switch to it. Follow with environment_save, user_create, account_create and credentials_put to set it up.', schema: z.object({ name: z.string().min(1).max(80) }) },
  workspace_switch: { description: 'Switch the desktop to another workspace. Closes current panes (they are restored when switching back). Fails while a protected login is running.', schema: z.object({ workspaceId: id }) },
  workspace_rename: { description: 'Rename a workspace.', schema: z.object({ workspaceId: id, name: z.string().min(1).max(80) }) },
  workspace_delete: { description: 'Permanently delete a workspace with all of its environments, users, credentials, panes and browser sessions. confirmName must equal the workspace name exactly.', schema: z.object({ workspaceId: id, confirmName: z.string().min(1).max(80) }) },
  environment_save: { description: 'Configure an environment URL and email/password login recipe. allowedOrigins lists extra origins (e.g. a hosted auth provider) that top-level navigation may visit; credentials are still only filled on the base origin.', schema: z.object({ id, name: z.string().min(1).max(60), baseUrl: z.string().max(2000), recipe: recipeSchema, allowedOrigins: z.array(z.string().max(300)).max(20).default([]), language: languageSchema.default({ cookie: '', storageKey: '', pathPrefix: false }) }) },
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
  recording_list: { description: 'List saved action recordings (metadata only) for the active workspace.', schema: z.object({}) },
  recording_get: { description: 'Return one recording with its steps. Password values are never recorded.', schema: z.object({ recordingId: id }) },
  recording_save: { description: 'Create or replace a recording (steps, per-step delays, speed, replay language, device).', schema: recordingSchema },
  recording_delete: { description: 'Delete a saved recording.', schema: z.object({ recordingId: id }) },
  recording_start: { description: 'Start recording user actions in a pane. Login pages and password fields are never recorded.', schema: z.object({ paneId: id, name: z.string().min(1).max(80).default('New recording'), recordedLang: lang.default('en') }) },
  recording_stop: { description: 'Stop the active recording and save it. Returns the recording id.', schema: z.object({}) },
  replay_start: { description: 'Replay a recording side by side: desktop (3/4) and emulated phone (1/4) in temporary sessions, in the replay language.', schema: z.object({ recordingId: id, lang: lang.optional(), speed: z.number().min(0.25).max(4).optional() }) },
  replay_control: { description: 'Control the running replay: pause, play, next, previous, retry, skip, speed, pick (the user clicks the right element in a view: on the phone for a hidden target it becomes a phone-only pre-step, otherwise it replaces the selectors of the step), highlight (outline what the selectors of the step match), inspect (DevTools for a view), copy (failure report to the clipboard), reveal (open the failure report folder), or exit.', schema: z.object({ action: z.enum(['pause', 'play', 'next', 'previous', 'retry', 'skip', 'speed', 'pick', 'highlight', 'inspect', 'copy', 'reveal', 'exit']), view: z.enum(['web', 'mobile']).optional(), speed: z.number().min(0.25).max(4).optional() }) },
  capture: { description: 'Capture a visible pane as PNG, masking form fields. Returns image content through MCP.', schema: z.object({ paneId: id }) },
} as const;
export type Command = keyof typeof specs;
export type Environment = { id: string; name: string; baseUrl: string; recipe: Recipe; demo?: boolean; allowedOrigins?: string[]; language?: LanguageRecipe };
export type User = { id: string; name: string; role: string };
export type Account = { id: string; userId: string; environmentId: string; label: string };
export type Split = { type: 'leaf'; paneId: string } | { type: 'split'; direction: 'row' | 'column'; ratio: number; first: Split; second: Split };
export type State = { version: 1; users: User[]; environments: Environment[]; accounts: Account[]; layout: Split | null };
export type Pane = { id: string; accountId: string; temporaryId?: string; sessionKey: string; url: string; title: string; busy: boolean; visible: boolean; devtools: boolean; blocked?: string; loadError?: string; replay?: 'web' | 'mobile'; recording?: boolean };
export class AppError extends Error { constructor(public code: string) { super(code); } }
export function requireValue<T>(value: T | undefined | null, code = 'not_found'): T { if (value == null) throw new AppError(code); return value; }
export function allowedUrl(path: string, base: string, extraOrigins: string[] = []): string {
  try { const root = new URL(base); const target = new URL(path, root); if (!['http:', 'https:'].includes(root.protocol) || !['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw 0; if (target.origin !== root.origin && !extraOrigins.includes(target.origin)) throw 0; return target.href; } catch { throw new AppError('origin_not_allowed'); }
}
export function normalizeOrigins(values: string[]): string[] { const out: string[] = []; for (const v of values) { const t = v.trim(); if (!t) continue; let origin = ''; try { const u = new URL(t.includes('://') ? t : 'https://' + t); if (['http:', 'https:'].includes(u.protocol)) origin = u.origin; } catch {} if (!origin) throw new AppError('invalid_origin'); if (!out.includes(origin)) out.push(origin); } return out; }
export function sessionKey(accountId: string, temporaryId?: string) { return temporaryId ? `temporary-${temporaryId}` : `persist:account-${accountId}`; }
