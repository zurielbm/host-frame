import { app, BrowserWindow, WebContentsView, clipboard, ipcMain, safeStorage, session, Session, shell } from 'electron';
import { join } from 'node:path';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, rmSync, readdirSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Account, AppError, Command, Pane, Recording, Split, allowedUrl, clampDelay, devices, isLoginUrl, localizePath, localizeSelector, normalizeOrigins, recipeSchema, recordingSchema, requireValue, sessionKey, specs, stepSchema } from './contracts';
import { Store, Vault, atomicJson, uid } from './store';
import { balancedLayout, removePane } from './layout';
import { demoUsers, startDemo } from './demo';
import { startBroker } from './broker';
import { checkAuthRedirects } from './auth-redirect-smoke';
import { loginStepScript } from './login';
import { WORLD, recorderScript } from './recorder';
import { Replay, ReplayError, Target } from './replay';

app.setName('Hostframe');
const smoke = process.argv.includes('--smoke-test');
const demoMode = smoke || process.argv.includes('--demo');
if (smoke) app.setPath('userData', join(process.cwd(),'artifacts','smoke-'+Date.now()));
// Retain the original storage location so the rebrand preserves accounts and Chromium sessions.
else app.setPath('userData', join(app.getPath('appData'),'Roleframe','desktop'));
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
let win: BrowserWindow;
let store: Store;
let vault: Vault;
const panes = new Map<string, { info: Pane; view: WebContentsView }>();
const locks = new Set<string>();
let stopBroker: (() => void) | undefined;
let stopDemo: (() => void) | undefined;
let demoUrl = '';
type WorkspaceMeta = { id: string; name: string; createdAt: string };
let workspaces: { active: string; list: WorkspaceMeta[] } = { active: '', list: [] };
const wsIndex = () => join(app.getPath('userData'), 'workspaces.json');
const wsDir = (id: string) => join(app.getPath('userData'), 'workspaces', id);
const saveWorkspaces = () => atomicJson(wsIndex(), workspaces);
function loadWorkspaces() {
  const root = app.getPath('userData');
  if (existsSync(wsIndex())) workspaces = JSON.parse(readFileSync(wsIndex(), 'utf8'));
  else if (existsSync(join(root, 'workspace.json'))) {
    // Migrate a pre-workspace data folder into the first named workspace.
    const id = uid(); mkdirSync(wsDir(id), { recursive: true });
    for (const f of ['workspace.json', 'vault.json', 'panes.json']) if (existsSync(join(root, f))) renameSync(join(root, f), join(wsDir(id), f));
    workspaces = { active: id, list: [{ id, name: 'Default', createdAt: new Date().toISOString() }] };
  }
  if (!Array.isArray(workspaces.list)) workspaces.list = [];
  if (!workspaces.list.length) { const id = uid(); workspaces.list.push({ id, name: 'Workspace', createdAt: new Date().toISOString() }); workspaces.active = id; }
  if (!workspaces.list.some(w => w.id === workspaces.active)) workspaces.active = workspaces.list[0].id;
  saveWorkspaces();
}
async function ensureDemo() { if (!demoUrl) { const demo = await startDemo(); stopDemo = demo.close; demoUrl = demo.url; } return demoUrl; }
let agentEnabled = true;
// A rebuild replaces dist/ under a running app; flag it so a stale build is never mistaken for a broken one.
const bootedAt = Date.now();
let staleChecked = 0, stale = false;
function staleBuild() { if (smoke || stale || Date.now() - staleChecked < 3000) return stale; staleChecked = Date.now(); try { stale = statSync(__filename).mtimeMs > bootedAt + 2000; } catch {} return stale; }
let overlay = false;
/** Overlay generation: a capture that finishes after the menu has closed is discarded. */
let overlayGen = 0;
/** Panes kept on screen while their still is being captured. */
const freezing = new Set<string>();
function freezePanes() {
  const gen = ++overlayGen; freezing.clear();
  const shown = [...panes.values()].filter(p => p.info.visible && !p.info.busy && !p.view.webContents.isDestroyed());
  for (const p of shown) freezing.add(p.info.id);
  Promise.all(shown.map(async p => { try { return [p.info.id, 'data:image/jpeg;base64,' + (await p.view.webContents.capturePage()).toJPEG(85).toString('base64')] as const; } catch { return [p.info.id, ''] as const; } }))
    .then(list => {
      if (gen !== overlayGen || !overlay) return;
      win.webContents.send('frames', Object.fromEntries(list.filter(([, url]) => url)));
      // Give the shell a frame to paint the stills before the live views disappear.
      setTimeout(() => { if (gen !== overlayGen || !overlay) return; for (const p of shown) { freezing.delete(p.info.id); if (!p.view.webContents.isDestroyed()) p.view.setVisible(false); } }, 40);
    });
}
let shuttingDown = false;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function logLine(kind: string, detail: string) { try { const line = `${new Date().toISOString()} ${kind} ${detail}\n`; process.stderr.write(line); writeFileSync(join(app.getPath('userData'), 'hostframe.log'), line, { flag: 'a' }); } catch {} }
const describe = (e: unknown) => e instanceof Error ? `${e.message}${e.stack ? ' | ' + e.stack.split('\n').slice(1, 3).join(' ').trim() : ''}` : String(e);
const paneFor = (id: string) => requireValue(panes.get(id),'pane_not_found');
const accountFor = (id: string) => requireValue(store.state.accounts.find(a => a.id === id),'account_not_found');
const envFor = (account: Account) => requireValue(store.state.environments.find(e => e.id === account.environmentId),'environment_not_found');
const safeUrl = (url: string) => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return ''; } };
function state() { return { ...store.state, workspaces, panes: [...panes.values()].map(p => ({ ...p.info, url: safeUrl(p.info.url), title: '' })), credentials: store.state.accounts.map(a => ({ accountId: a.id, ...vault.status(a.id) })), agentEnabled, recordings: [...recordings.values()].map(summary), build: { stale: staleBuild(), startedAt: new Date(bootedAt).toISOString() }, recording: recording ? { paneId: recording.paneId, recordingId: recording.rec.id, steps: recording.rec.steps.length, startedAt: recording.startedAt } : null, replay: replayState() }; }
function changed() { if (win && !win.isDestroyed()) win.webContents.send('state', state()); }
function savePanes() { atomicJson(join(store.directory,'panes.json'), [...panes.values()].filter(p => !p.info.temporaryId).map(p => ({ id: p.info.id, accountId: p.info.accountId, path: new URL(p.info.url).pathname }))); }
function validateTemporary(accountId: string, temporaryId?: string) { if (temporaryId && ![...panes.values()].some(p => p.info.temporaryId === temporaryId && p.info.accountId === accountId)) throw new AppError('temporary_not_found'); }
function assertFree(info: Pane) { if (locks.has(info.sessionKey)) throw new AppError('session_busy'); if ([...panes.values()].some(p=>p.info.sessionKey===info.sessionKey&&p.info.devtools)) throw new AppError('devtools_open'); }
async function exclusive<T>(info: Pane, fn: () => Promise<T>): Promise<T> {
  assertFree(info); locks.add(info.sessionKey);
  for (const p of panes.values()) if (p.info.sessionKey === info.sessionKey) p.info.busy = true;
  changed();
  try { return await fn(); } finally { locks.delete(info.sessionKey); for (const p of panes.values()) if (p.info.sessionKey === info.sessionKey) p.info.busy = false; changed(); }
}
function updateLayout() { store.state.layout = balancedLayout([...panes.values()].filter(p => !p.info.replay).map(p => p.info.id)); store.save(); changed(); }
type PaneOptions = { replay?: 'web' | 'mobile'; prepare?: (view: WebContentsView, ses: Session) => Promise<void> };
async function openPane(accountId: string, path = '/', temporaryId?: string, restoredId?: string, opts: PaneOptions = {}) {
  const account = accountFor(accountId), env = envFor(account); const url = allowedUrl(path, env.baseUrl, env.allowedOrigins || []);
  const key = sessionKey(accountId,temporaryId);
  const ses = session.fromPartition(key);
  ses.setPermissionRequestHandler((_wc,_permission,callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  // Downloads have a separate lifecycle; deny until tracked cleanup is implemented.
  if (ses.listenerCount('will-download') === 0) ses.on('will-download', e => e.preventDefault());
  const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: true } });
  const info: Pane = { id: restoredId || uid(), accountId, temporaryId, sessionKey: key, url, title: '', busy: false, visible: false, devtools: false, replay: opts.replay };
  panes.set(info.id, { info, view }); win.contentView.addChildView(view); view.setVisible(false);
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guard = (event: Electron.Event, destination: string) => { const live = store.state.environments.find(e => e.id === env.id) || env; try { allowedUrl(destination, live.baseUrl, live.allowedOrigins || []); info.blocked = undefined; } catch { event.preventDefault(); let origin = destination; try { origin = new URL(destination).origin; } catch {} info.blocked = origin; logLine('navigation_blocked', `${info.id} -> ${origin}`); changed(); } };
  view.webContents.on('will-navigate', guard); view.webContents.on('will-redirect', guard);
  view.webContents.on('did-navigate', (_event,destination) => { info.url = destination; info.loadError = undefined; changed(); });
  view.webContents.on('did-fail-load', (_event, code, description, failedUrl, isMainFrame) => { if (!isMainFrame || code === -3) return; info.loadError = `${description} (${code})`; logLine('load_failed', `${info.id} ${failedUrl} ${description} ${code}`); changed(); });
  view.webContents.on('did-navigate-in-page', (_event,destination) => { info.url = destination; changed(); });
  view.webContents.on('devtools-opened', () => { info.devtools = true; changed(); });
  view.webContents.on('devtools-closed', () => { info.devtools = false; changed(); });
  view.webContents.on('render-process-gone', (_event, details) => { info.title = 'Renderer stopped'; info.loadError = `Renderer stopped (${details.reason})`; logLine('renderer_gone', `${info.id} ${details.reason}`); changed(); });
  if (!opts.replay) updateLayout(); else changed();
  if (opts.prepare) await opts.prepare(view, ses);
  try { await view.webContents.loadURL(url); } catch { /* Keep the pane available for URL correction/retry. */ }
  savePanes(); changed(); return { paneId: info.id, temporaryId, sessionKey: key };
}
function closeAll() { for (const p of panes.values()) { win.contentView.removeChildView(p.view); if (!p.view.webContents.isDestroyed()) p.view.webContents.close({ waitForBeforeUnload: false }); } panes.clear(); locks.clear(); }
async function activate(id: string) {
  const meta = requireValue(workspaces.list.find(w => w.id === id), 'workspace_not_found');
  if (store) { for (const p of panes.values()) assertFree(p.info); await exitReplay(); stopRecording(); savePanes(); closeAll(); }
  workspaces.active = meta.id; saveWorkspaces();
  store = new Store(wsDir(meta.id)); loadRecordings(); vault = new Vault(store.directory, v => safeStorage.encryptString(v), v => safeStorage.decryptString(v));
  let fresh = false;
  // The bundled Dispatch demo only runs when asked for (--demo / smoke) or when this workspace already references it.
  if (demoMode || store.state.environments.some(e => e.demo)) fresh = await seed(await ensureDemo());
  const prior = join(store.directory, 'panes.json'); const previousLayout = store.state.layout;
  const saved: { id?: string; accountId: string; path: string }[] = fresh ? store.state.accounts.map(a => ({ accountId: a.id, path: '/login' })) : existsSync(prior) ? JSON.parse(readFileSync(prior, 'utf8')) : [];
  for (const item of saved.slice(0, 40)) { try { await openPane(item.accountId, item.path, undefined, item.id); } catch {} }
  if (previousLayout) { const leaves = (t: Split): string[] => t.type === 'leaf' ? [t.paneId] : [...leaves(t.first), ...leaves(t.second)]; let restored: Split | null = previousLayout; for (const pid of leaves(previousLayout)) if (!panes.has(pid)) restored = removePane(restored, pid); if (restored && leaves(restored).length === panes.size) { store.state.layout = restored; store.save(); } }
  changed();
}
function createWorkspace(name: string) { const meta = { id: uid(), name: name.trim() || 'Workspace', createdAt: new Date().toISOString() }; mkdirSync(wsDir(meta.id), { recursive: true }); workspaces.list.push(meta); saveWorkspaces(); return meta; }
async function deleteWorkspace(id: string) {
  const meta = requireValue(workspaces.list.find(w => w.id === id), 'workspace_not_found');
  if (workspaces.list.length === 1) createWorkspace('Workspace');
  if (workspaces.active === id) { for (const p of panes.values()) assertFree(p.info); await activate(workspaces.list.find(w => w.id !== id)!.id); }
  // Wipe every browser session the workspace owned, then its files.
  let accounts: Account[] = []; try { accounts = JSON.parse(readFileSync(join(wsDir(id), 'workspace.json'), 'utf8')).accounts || []; } catch {}
  for (const a of accounts) { const ses = session.fromPartition(sessionKey(a.id)); await ses.clearStorageData(); await ses.clearCache(); await ses.clearAuthCache(); await ses.closeAllConnections(); }
  rmSync(wsDir(id), { recursive: true, force: true });
  workspaces.list = workspaces.list.filter(w => w.id !== meta.id); saveWorkspaces(); changed();
}
async function closePane(id: string) {
  const p = paneFor(id); assertFree(p.info);
  if (recording?.paneId === id) stopRecording();
  win.contentView.removeChildView(p.view); p.view.webContents.close({ waitForBeforeUnload: false }); panes.delete(id);
  store.state.layout = removePane(store.state.layout,id); store.save(); savePanes(); changed();
}
async function deleteAccount(accountId: string) {
  const account = accountFor(accountId);
  const owned = [...panes.values()].filter(p => p.info.accountId === accountId);
  owned.forEach(p => assertFree(p.info));
  for (const temp of new Set(owned.map(p => p.info.temporaryId).filter((t): t is string => !!t))) await deleteTemporary(temp);
  for (const p of owned) if (panes.has(p.info.id)) await closePane(p.info.id);
  const ses = session.fromPartition(sessionKey(accountId));
  await ses.clearStorageData(); await ses.clearCache(); await ses.clearAuthCache(); await ses.closeAllConnections();
  vault.remove(accountId);
  store.state.accounts = store.state.accounts.filter(a => a.id !== account.id); store.save(); savePanes(); changed();
}
async function deleteUser(userId: string) {
  requireValue(store.state.users.find(u => u.id === userId), 'user_not_found');
  for (const account of store.state.accounts.filter(a => a.userId === userId)) await deleteAccount(account.id);
  store.state.users = store.state.users.filter(u => u.id !== userId); store.save(); changed();
}
async function deleteTemporary(id: string) {
  const targets = [...panes.values()].filter(p => p.info.temporaryId === id); if (!targets.length) throw new AppError('temporary_not_found');
  targets.forEach(p => assertFree(p.info)); const sessions = [...new Set(targets.map(p => p.view.webContents.session))];
  for (const p of targets) await closePane(p.info.id);
  for (const ses of sessions) { await ses.clearStorageData(); await ses.clearCache(); await ses.clearAuthCache(); await ses.closeAllConnections(); }
  vault.removeTemporary(id); return { deleted: true };
}
async function waitVisible(p: ReturnType<typeof paneFor>, selector: string, timeout: number) {
  const until = Date.now()+timeout;
  while (Date.now()<until) {
    if (p.view.webContents.isDestroyed()) throw new AppError('target_closed');
    try { if (await p.view.webContents.executeJavaScript(`(()=>Array.from(document.querySelectorAll(${JSON.stringify(selector)})).some(e=>e.getClientRects().length>0))()`)) return; } catch { /* Navigation can replace the execution context. */ }
    await delay(120);
  }
  throw new AppError('selector_timeout');
}
function isLoginPage(p: ReturnType<typeof paneFor>) {
  const env = envFor(accountFor(p.info.accountId));
  return isLoginUrl(p.info.url,env.baseUrl,env.recipe.path);
}
async function login(p: ReturnType<typeof paneFor>) {
  const account = accountFor(p.info.accountId), env = envFor(account); const recipe = env.recipe;
  return exclusive(p.info, async () => {
    // Hide all views sharing this identity while a secret is in the renderer.
    for (const sibling of panes.values()) if (sibling.info.sessionKey === p.info.sessionKey) sibling.view.setVisible(false);
    let phase = 'vault';
    let pair: { email: string; password: string } | undefined;
    try {
      pair = vault.use(account.id,p.info.temporaryId);
      phase = 'navigation';
      await p.view.webContents.loadURL(allowedUrl(recipe.path,env.baseUrl));
      phase = 'fields';
      await waitVisible(p,recipe.email,8000);
      phase = 'submission';
      const origin = new URL(env.baseUrl).origin;
      let result = await p.view.webContents.executeJavaScript(loginStepScript(recipe,origin,pair,'identifier'));
      if (result === 'password_required') {
        phase = 'password_step';
        await waitVisible(p,recipe.password,12000);
        result = await p.view.webContents.executeJavaScript(loginStepScript(recipe,origin,pair,'password'));
      }
      pair.email = ''; pair.password = '';
      if (result !== 'submitted') throw new AppError('login_recipe_mismatch');
      phase = 'verification';
      if (!recipe.success) { await delay(700); return { outcome:'submitted', verification:'unverified', accountId: account.id }; }
      await waitVisible(p,recipe.success,12000);
      // A success marker alone does not prove identity. Compare configured marker text with account label.
      if (recipe.identity) {
        const matches = await p.view.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(recipe.identity)});return !!e&&e.textContent.trim()===${JSON.stringify(account.label)}})()`);
        if (!matches) throw new AppError('identity_mismatch');
      }
      return { outcome:'success_marker_observed', verification: recipe.identity ? 'identity_label_matched' : 'identity_unverified', accountId:account.id };
    } catch(error) { if(error instanceof AppError)throw error;throw new AppError(`login_${phase}_failed`); } finally {
      if(pair){pair.email='';pair.password='';}
      try { await p.view.webContents.executeJavaScript(`(()=>{for(const s of ${JSON.stringify([recipe.email,recipe.password])}){const e=document.querySelector(s);if(e&&'value' in e)e.value='';}})()`); } catch {}
      for (const sibling of panes.values()) if (sibling.info.sessionKey === p.info.sessionKey) sibling.view.setVisible(sibling.info.visible && !overlay);
    }
  });
}
async function capture(p: ReturnType<typeof paneFor>) {
  if (!p.info.visible || overlay) throw new AppError('pane_not_visible');
  if (isLoginPage(p)) throw new AppError('protected_login_page');
  return exclusive(p.info,async () => {
    const styleId = await p.view.webContents.insertCSS('input,textarea,select,form,[contenteditable=true]{visibility:hidden!important}');
    try { await delay(80); const image = await p.view.webContents.capturePage(); return { paneId:p.info.id,accountId:p.info.accountId,environmentId:accountFor(p.info.accountId).environmentId, captureId:uid(), timestamp:new Date().toISOString(), viewport:p.view.getBounds(), scaleFactor:win.webContents.getZoomFactor(), image:image.toPNG().toString('base64') }; }
    finally { if (!p.view.webContents.isDestroyed()) await p.view.webContents.removeInsertedCSS(styleId); }
  });
}
/* ---------- recordings ---------- */
const recordings = new Map<string, Recording>();
const recDir = () => join(store.directory, 'recordings');
function loadRecordings() {
  recordings.clear(); const dir = recDir(); if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) { if (!f.endsWith('.json')) continue; try { const r = recordingSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))); recordings.set(r.id, r); } catch (e) { logLine('recording_unreadable', `${f} ${describe(e)}`); } }
}
function saveRecording(rec: Recording) { const parsed = recordingSchema.parse(rec); mkdirSync(recDir(), { recursive: true }); atomicJson(join(recDir(), parsed.id + '.json'), parsed); recordings.set(parsed.id, parsed); changed(); return parsed; }
function summary(r: Recording) { return { id: r.id, name: r.name, environmentId: r.environmentId, accountId: r.accountId, steps: r.steps.length, createdAt: r.createdAt, replayLang: r.replayLang }; }
const pathOf = (url: string) => { try { const u = new URL(url); return u.pathname + u.search; } catch { return '/'; } };
const newPrefix = () => `__hf${randomBytes(9).toString('hex')}:`;
type Recorder = { paneId: string; rec: Recording; startedAt: number; last: number; lastActionAt: number; lastUrl: string; detach: () => void };
let recording: Recorder | undefined;
function addStep(r: Recorder, raw: Record<string, unknown>) {
  const now = Date.now(), steps = r.rec.steps, prev = steps[steps.length - 1];
  if (raw.kind === 'scroll' && prev?.kind === 'scroll') { prev.scroll = Number(raw.scroll); prev.label = String(raw.label || ''); changed(); return; }
  const parsed = stepSchema.safeParse({ ...raw, id: uid(), delayMs: steps.length ? clampDelay(now - r.last) : 0 });
  if (!parsed.success || steps.length >= 500) { logLine('recording_step_rejected', String(raw.kind)); return; }
  steps.push(parsed.data); r.last = now;
  if (['click', 'type', 'select', 'check', 'key'].includes(parsed.data.kind)) r.lastActionAt = now;
  changed();
}
function startRecording(paneId: string, name: string, recordedLang: string) {
  if (recording) throw new AppError('recording_in_progress'); if (replay) throw new AppError('replay_in_progress');
  const p = paneFor(paneId); if (p.info.replay) throw new AppError('pane_is_replaying'); assertFree(p.info);
  const account = accountFor(p.info.accountId), wc = p.view.webContents, prefix = newPrefix(), now = Date.now();
  const rec = recordingSchema.parse({ id: uid(), name, environmentId: account.environmentId, accountId: account.id, recordedLang, createdAt: new Date().toISOString(), steps: [] });
  const r: Recorder = { paneId, rec, startedAt: now, last: now, lastActionAt: 0, lastUrl: p.info.url, detach: () => {} };
  if (!isLoginPage(p)) addStep(r, { kind: 'navigate', path: pathOf(p.info.url), label: pathOf(p.info.url) });
  const inject = () => { wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: recorderScript(prefix, 'record') }]).catch(() => {}); };
  const onConsole = (details: { message?: string }) => {
    const message = details?.message ?? ''; if (!message.startsWith(prefix) || recording !== r || isLoginPage(p)) return;
    try { const raw = JSON.parse(message.slice(prefix.length)); if (raw && typeof raw === 'object' && raw.kind !== 'pick') addStep(r, raw); } catch {}
  };
  const login = (u: string) => { const env = envFor(account); try { return isLoginUrl(u, env.baseUrl, env.recipe.path); } catch { return false; } };
  const onNavigate = (_event: unknown, url: string, isMainFrame?: unknown) => {
    if (isMainFrame === false) return;
    const was = r.lastUrl; r.lastUrl = url; if (pathOf(was) === pathOf(url) || login(url)) return;
    const prev = r.rec.steps[r.rec.steps.length - 1];
    if (login(was)) { if (prev?.kind !== 'login') addStep(r, { kind: 'login', label: 'Sign in with saved credentials' }); return; }
    // Navigation right after a click or key press is its consequence; replaying the action reproduces it.
    if (Date.now() - r.lastActionAt > 1500) addStep(r, { kind: 'navigate', path: pathOf(url), label: pathOf(url) });
  };
  const events = { 'console-message': onConsole, 'dom-ready': inject, 'did-navigate': onNavigate, 'did-navigate-in-page': onNavigate } as Record<string, (...args: any[]) => void>;
  for (const [name, fn] of Object.entries(events)) wc.on(name as any, fn);
  r.detach = () => { if (wc.isDestroyed()) return; for (const [name, fn] of Object.entries(events)) wc.off(name as any, fn); wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: recorderScript(prefix, 'off') }]).catch(() => {}); };
  recording = r; p.info.recording = true; inject(); changed();
  return { recordingId: rec.id };
}
function stopRecording() {
  const r = recording; if (!r) return undefined;
  recording = undefined; r.detach(); const p = panes.get(r.paneId); if (p) p.info.recording = false;
  saveRecording(r.rec); return { recordingId: r.rec.id, steps: r.rec.steps.length };
}

/* ---------- replay: web 3/4 | mobile 1/4 ---------- */
type Device = (typeof devices)[keyof typeof devices];
type ConsoleLine = { at: string; level: string; text: string };
type ReplaySession = { engine: Replay; rec: Recording; web: string; mobile: string; temps: string[]; device: Device; picking?: 'web' | 'mobile'; scales: Map<string, number>; consoles: Map<string, ConsoleLine[]>; unlocalize: (selector: string) => string; report?: { error: ReplayError; data: object } };
let replay: ReplaySession | undefined;
function replayState() {
  if (!replay) return null; const e = replay.engine, step = e.current;
  return { recordingId: replay.rec.id, name: replay.rec.name, index: e.index, total: e.rec.steps.length, status: e.status, speed: e.speed, lang: e.lang, step: step ? { kind: step.kind, label: step.label || step.path || '' } : null, error: e.error, picking: replay.picking ?? null, waiting: [...e.waiting.values()], log: e.log.slice(-80), detail: step ? { selectors: step.selectors ?? [], target: step.target, optional: step.optional, fragile: step.fragile, mobilePre: step.mobilePre.length } : null, stale: staleBuild(), web: replay.web, mobile: replay.mobile, device: { name: replay.device.name, width: replay.device.width, height: replay.device.height } };
}
async function startReplay(recordingId: string, lang?: string, speed?: number) {
  if (replay) throw new AppError('replay_in_progress'); if (recording) throw new AppError('recording_in_progress');
  const rec = requireValue(recordings.get(recordingId), 'recording_not_found');
  const account = accountFor(rec.accountId), env = envFor(account), device = devices[rec.device];
  const L = lang || rec.replayLang, acceptLanguage = L.includes('-') ? `${L},${L.split('-')[0]};q=0.9` : L;
  const language = env.language || { cookie: '', storageKey: '', pathPrefix: false };
  const localize = (path: string) => language.pathPrefix ? localizePath(path, rec.recordedLang, L) : path;
  const play: Recording = structuredClone(rec);
  if (language.pathPrefix) for (const s of play.steps) { if (s.selectors) s.selectors = s.selectors.map(x => localizeSelector(x, rec.recordedLang, L)); s.mobilePre = s.mobilePre.map(list => list.map(x => localizeSelector(x, rec.recordedLang, L))); }
  const cookies = await session.fromPartition(sessionKey(account.id)).cookies.get({});
  const first = rec.steps.find(s => s.kind === 'navigate')?.path || '/';
  const opened: { kind: 'web' | 'mobile'; paneId: string; temp: string }[] = [];
  try {
    for (const kind of ['web', 'mobile'] as const) {
      const temp = uid(), userAgent = kind === 'mobile' ? device.userAgent : app.userAgentFallback;
      const prepare = async (_view: WebContentsView, ses: Session) => {
        // Start from the signed-in session, then switch only this disposable copy to the replay language.
        for (const c of cookies) { try { await ses.cookies.set({ url: `${c.secure ? 'https' : 'http'}://${(c.domain || '').replace(/^\./, '')}${c.path || '/'}`, name: c.name, value: c.value, domain: c.hostOnly ? undefined : c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, expirationDate: c.expirationDate, sameSite: c.sameSite }); } catch {} }
        if (language.cookie) await ses.cookies.set({ url: env.baseUrl, name: language.cookie, value: L, path: '/' });
        ses.setUserAgent(userAgent, acceptLanguage);
      };
      const r = await openPane(account.id, localize(first), temp, undefined, { replay: kind, prepare });
      // DevTools emulation needs a live renderer, so apply it after the first load and reload once.
      const wc = paneFor(r.paneId).view.webContents, dbg = wc.debugger;
      dbg.attach('1.3');
      await dbg.sendCommand('Emulation.setUserAgentOverride', { userAgent, acceptLanguage, ...(kind === 'mobile' ? { platform: device.platform } : {}) });
      await dbg.sendCommand('Emulation.setLocaleOverride', { locale: L });
      if (kind === 'mobile') {
        await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: device.width, height: device.height, deviceScaleFactor: device.scale, mobile: true });
        await dbg.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      }
      try { await wc.loadURL(wc.getURL()); } catch { /* Redirects abort the first load. */ }
      opened.push({ kind, paneId: r.paneId, temp });
    }
    for (const o of opened) {
      const p = paneFor(o.paneId);
      if (isLoginPage(p) && vault.status(account.id).configured) await login(p);
      if (language.storageKey) { await p.view.webContents.executeJavaScript(`localStorage.setItem(${JSON.stringify(language.storageKey)},${JSON.stringify(L)})`).catch(() => {}); p.view.webContents.reload(); }
    }
  } catch (e) { for (const o of opened) await deleteTemporary(o.temp).catch(() => {}); throw e; }
  const target = (o: typeof opened[number]): Target => {
    const p = paneFor(o.paneId), wc = p.view.webContents;
    return {
      kind: o.kind,
      run: code => wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]),
      cdp: (method, params) => wc.debugger.sendCommand(method, params),
      navigate: async path => { const live = envFor(account); const url = allowedUrl(localize(path), live.baseUrl, live.allowedOrigins || []); try { await wc.loadURL(url); } catch { /* Redirects abort the first load. */ } },
      login: async () => { await login(p); },
      isLoginPage: () => isLoginPage(p),
      loading: () => !wc.isDestroyed() && wc.isLoading(),
      alive: () => !wc.isDestroyed(),
      scale: () => o.kind === 'mobile' ? (replay?.scales.get(o.paneId) ?? device.width) / device.width : 1,
    };
  };
  // Page warnings and errors go into failure reports.
  const consoles = new Map<string, ConsoleLine[]>();
  for (const o of opened) {
    const lines: ConsoleLine[] = [], wc = paneFor(o.paneId).view.webContents; consoles.set(o.paneId, lines);
    const push = (level: string, text: string) => { lines.push({ at: new Date().toISOString(), level, text: text.slice(0, 600) }); if (lines.length > 40) lines.shift(); };
    wc.on('console-message', (details: any) => { if (details?.level === 'warning' || details?.level === 'error') push(details.level, String(details.message ?? '')); });
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => { if (isMainFrame) push('load', `${code} ${description} ${safeUrl(url)}`); });
    wc.on('render-process-gone', (_e, details) => push('crash', details.reason));
  }
  const engine = new Replay(play, opened.map(target), L, speed ?? rec.speed, changed, error => { if (replay?.engine === engine) writeReport(replay, error).catch(e => logLine('replay_report_failed', describe(e))); });
  engine.status = 'paused';
  replay = { engine, rec, web: opened[0].paneId, mobile: opened[1].paneId, temps: opened.map(o => o.temp), device, scales: new Map(), consoles, unlocalize: x => language.pathPrefix ? localizeSelector(x, L, rec.recordedLang) : x };
  changed();
  engine.run().catch(e => logLine('replay_failed', describe(e)));
  // Let the stage lay out before the first action.
  setTimeout(() => { if (replay?.engine === engine && engine.status === 'paused' && engine.index === 0 && !engine.error) engine.play(); }, 900);
  return { web: replay.web, mobile: replay.mobile };
}
/** Everything needed to debug a failed step later: what was attempted, what each view showed, page errors and recent timings. */
function failureReport(r: ReplaySession, error: ReplayError) {
  const e = r.engine, step = e.rec.steps[error.index];
  return {
    app: 'Hostframe', version: app.getVersion(), at: error.at, build: { startedAt: new Date(bootedAt).toISOString(), stale: staleBuild() },
    recording: { id: r.rec.id, name: r.rec.name, recordedLang: r.rec.recordedLang, replayLang: e.lang, speed: e.speed, device: r.device.name, steps: e.rec.steps.length },
    step: { number: error.index + 1, ...step },
    failures: error.failures,
    views: ([['web', r.web], ['mobile', r.mobile]] as const).map(([view, id]) => { const p = panes.get(id); return { view, url: p ? safeUrl(p.info.url) : '', console: r.consoles.get(id) ?? [] }; }),
    timeline: e.log.slice(-40),
  };
}
async function writeReport(r: ReplaySession, error: ReplayError) {
  const data = failureReport(r, error); r.report = { error, data };
  const root = join(store.directory, 'replay-reports'), dir = join(root, `${error.at.replace(/[:.]/g, '-')}-step-${error.index + 1}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'report.json'), JSON.stringify(data, null, 2));
  for (const [view, id] of [['web', r.web], ['mobile', r.mobile]] as const) {
    const p = panes.get(id); if (p && !p.view.webContents.isDestroyed()) writeFileSync(join(dir, view + '.png'), (await p.view.webContents.capturePage()).toPNG());
  }
  for (const old of readdirSync(root).sort().slice(0, -30)) rmSync(join(root, old), { recursive: true, force: true });
  logLine('replay_step_failed', `${r.rec.id} step ${error.index + 1} ${error.failures.map(f => `${f.target}:${f.code}`).join(' ')} ${dir}`);
  if (r.engine.error === error) { error.report = dir; changed(); }
}
async function exitReplay() {
  const r = replay; if (!r) return; replay = undefined; r.engine.stop();
  for (const id of [r.web, r.mobile]) { try { panes.get(id)?.view.webContents.debugger.detach(); } catch {} }
  for (const t of r.temps) await deleteTemporary(t).catch(e => logLine('replay_cleanup', describe(e)));
  changed();
}
function applyMobileScale(p: { info: Pane; view: WebContentsView }, width: number) {
  const r = replay; if (!r || r.scales.get(p.info.id) === width || width < 80) return; r.scales.set(p.info.id, width);
  p.view.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: r.device.width, height: r.device.height, deviceScaleFactor: r.device.scale, mobile: true, scale: width / r.device.width }).catch(() => {});
}
/**
 * The user clicks the right element in a view. On the phone, for a target hidden behind something (usually a menu),
 * the click becomes a phone-only pre-step; otherwise it replaces the step's selectors. Either way the click already
 * did the work in that view, so replay carries on from there.
 */
async function pick(r: ReplaySession, view: 'web' | 'mobile') {
  const e = r.engine; if (!e.error || e.status !== 'paused') throw new AppError('nothing_to_fix');
  const index = e.error.index, failure = e.error.failures.find(f => f.target === view);
  const pre = view === 'mobile' && failure?.code === 'element_hidden';
  const wc = paneFor(view === 'web' ? r.web : r.mobile).view.webContents, prefix = newPrefix();
  const onConsole = (details: { message?: string }) => {
    const message = details?.message ?? ''; if (!message.startsWith(prefix)) return;
    wc.off('console-message', onConsole); r.picking = undefined;
    try {
      const raw = JSON.parse(message.slice(prefix.length));
      const selectors = stepSchema.shape.selectors.unwrap().parse(raw.selectors), target = stepSchema.shape.target.safeParse(raw.target);
      for (const [rec, list] of [[r.rec, selectors.map(r.unlocalize)], [e.rec, selectors]] as const) {
        const step = rec.steps[index]; if (!step) continue;
        if (pre) { if (step.mobilePre.length < 4) step.mobilePre.push(list); continue; }
        step.selectors = list; step.fragile = !!raw.fragile; step.optional = false; step.at = undefined; if (target.success) step.target = target.data;
      }
      saveRecording(r.rec);
      logLine('replay_pick', `${r.rec.id} step ${index + 1} ${view} ${pre ? 'pre-step' : 'selectors'} ${selectors.join(' | ')}`);
      // The click opened the menu (pre-step: retry without repeating it) or did the step itself.
      setTimeout(() => { if (replay !== r) return; if (pre) e.retry(true); else e.handled(view); }, 450);
    } catch (err) { logLine('replay_pick_failed', describe(err)); changed(); }
  };
  wc.on('console-message', onConsole); r.picking = view; changed();
  await wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: recorderScript(prefix, 'pick') }]);
}
export async function dispatch(command: string, params: unknown, agent = false): Promise<any> {
  if (agent && !agentEnabled) throw new AppError('agent_paused');
  const spec = specs[command as Command]; if (!spec) throw new AppError('unknown_command');
  const parsed = spec.schema.safeParse(params); if (!parsed.success) throw new AppError('invalid_arguments'); const a: any = parsed.data;
  switch (command) {
    case 'state_get': return state();
    case 'workspace_list': return workspaces;
    case 'workspace_create': { const meta = createWorkspace(a.name); await activate(meta.id); return meta; }
    case 'workspace_switch': await activate(a.workspaceId); return { active: workspaces.active };
    case 'workspace_rename': { const meta = requireValue(workspaces.list.find(w => w.id === a.workspaceId), 'workspace_not_found'); meta.name = a.name.trim(); saveWorkspaces(); changed(); return meta; }
    case 'workspace_delete': { const meta = requireValue(workspaces.list.find(w => w.id === a.workspaceId), 'workspace_not_found'); if (meta.name !== a.confirmName) throw new AppError('confirm_name_mismatch'); await deleteWorkspace(meta.id); return { deleted: true, active: workspaces.active }; }
    case 'environment_save': {
      if (a.baseUrl) allowedUrl('/',a.baseUrl);
      if (a.baseUrl) allowedUrl(a.recipe.path,a.baseUrl);
      a.allowedOrigins = normalizeOrigins(a.allowedOrigins || []);
      const active = [...panes.values()].filter(p => accountFor(p.info.accountId).environmentId === a.id); active.forEach(p => assertFree(p.info));
      // Close old-origin sessions before changing configuration. No silent credential reuse on a new origin.
      const previous = store.state.environments.find(e => e.id === a.id);
      if (previous?.baseUrl && a.baseUrl && new URL(previous.baseUrl).origin !== new URL(a.baseUrl).origin && store.state.accounts.some(ac => ac.environmentId === a.id)) throw new AppError('new_origin_requires_new_environment');
      const originChanged = !!previous?.baseUrl && !!a.baseUrl && new URL(previous.baseUrl).origin !== new URL(a.baseUrl).origin;
      if (originChanged) for (const p of active) { if (!panes.has(p.info.id)) continue; if (p.info.temporaryId) await deleteTemporary(p.info.temporaryId); else await closePane(p.info.id); }
      store.state.environments = [...store.state.environments.filter(e => e.id!==a.id),a]; store.save(); changed(); return { saved:true };
    }
    case 'user_create': { const u = { id:uid(),name:a.name,role:a.role }; store.state.users.push(u);store.save();changed();return u; }
    case 'user_delete': await deleteUser(a.userId); return { deleted: true };
    case 'account_delete': await deleteAccount(a.accountId); return { deleted: true };
    case 'account_create': { requireValue(store.state.users.find(u=>u.id===a.userId)); requireValue(store.state.environments.find(e=>e.id===a.environmentId)); const account = { id:uid(),...a };store.state.accounts.push(account);store.save();changed();return account; }
    case 'credentials_status': accountFor(a.accountId);validateTemporary(a.accountId,a.temporaryId);return vault.status(a.accountId,a.temporaryId);
    case 'credentials_put': case 'credentials_generate': {
      accountFor(a.accountId);validateTemporary(a.accountId,a.temporaryId);
      for (const p of panes.values()) if (p.info.accountId===a.accountId) assertFree(p.info);
      const result = vault.put(a.accountId,{email:a.email,password:command==='credentials_generate'?randomBytes(24).toString('base64url'):a.password},a.expectedRevision,a.temporaryId); changed();return result;
    }
    case 'pane_open': return openPane(a.accountId,a.path);
    case 'pane_copy': { const p=paneFor(a.paneId);assertFree(p.info);return openPane(p.info.accountId,new URL(p.info.url).pathname,a.temporary?uid():p.info.temporaryId); }
    case 'pane_close': { const p=paneFor(a.paneId);if(p.info.temporaryId && [...panes.values()].filter(x=>x.info.temporaryId===p.info.temporaryId).length===1)return deleteTemporary(p.info.temporaryId);await closePane(a.paneId);return {closed:true}; }
    case 'temporary_delete': return deleteTemporary(a.temporaryId);
    case 'pane_navigate': { const p=paneFor(a.paneId);return exclusive(p.info,async()=>{const env=envFor(accountFor(p.info.accountId));await p.view.webContents.loadURL(allowedUrl(a.path,env.baseUrl,env.allowedOrigins || []));savePanes();return {navigated:true};}); }
    case 'auth_login': return login(paneFor(a.paneId));
    case 'capture': return capture(paneFor(a.paneId));
    case 'page_wait': { const p=paneFor(a.paneId);return exclusive(p.info,async()=>{if(isLoginPage(p))throw new AppError('protected_login_page');await waitVisible(p,a.selector,a.timeoutMs);return {visible:true};}); }
    case 'page_snapshot': case 'page_click': case 'page_fill': {
      const p=paneFor(a.paneId);if(isLoginPage(p))throw new AppError('protected_login_page');
      return exclusive(p.info,async()=>{
        if(command==='page_snapshot')return p.view.webContents.executeJavaScript(`(()=>{const clone=document.body.cloneNode(true);clone.querySelectorAll('form,input,textarea,select,script,style,[contenteditable]').forEach(e=>e.remove());return {text:clone.innerText?.slice(0,16000)||clone.textContent.slice(0,16000),elements:Array.from(document.querySelectorAll('button,a,input,textarea')).filter(e=>!e.closest('form')&&!['password','email','hidden'].includes(e.type)).slice(0,100).map(e=>({tag:e.tagName.toLowerCase(),id:e.id,text:e.tagName==='INPUT'?'':e.textContent.slice(0,120)}))}})()`);
        const result=await p.view.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(a.selector)});if(!e||e.closest('form')?.querySelector('input[type=password]')||['password','email','hidden'].includes(e.type))return false;${command==='page_click'?"e.click();":`if(!(e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement))return false;const proto=e instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(a.text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));`}return true})()`);
        if(!result)throw new AppError('element_unavailable_or_protected');return {done:true};
      });
    }
    case 'recording_list': return [...recordings.values()].map(summary);
    case 'recording_get': return requireValue(recordings.get(a.recordingId), 'recording_not_found');
    case 'recording_save': {
      accountFor(a.accountId); requireValue(store.state.environments.find(e => e.id === a.environmentId), 'environment_not_found');
      if (recording?.rec.id === a.id) throw new AppError('recording_in_progress');
      return summary(saveRecording(a));
    }
    case 'recording_delete': {
      requireValue(recordings.get(a.recordingId), 'recording_not_found'); if (replay?.rec.id === a.recordingId) throw new AppError('replay_in_progress');
      rmSync(join(recDir(), a.recordingId + '.json'), { force: true }); recordings.delete(a.recordingId); changed(); return { deleted: true };
    }
    case 'recording_start': return startRecording(a.paneId, a.name, a.recordedLang);
    case 'recording_stop': return requireValue(stopRecording(), 'recording_not_running');
    case 'replay_start': return startReplay(a.recordingId, a.lang, a.speed);
    case 'replay_control': {
      const r = requireValue(replay, 'replay_not_running'), e = r.engine;
      if (a.action === 'exit') { await exitReplay(); return { exited: true }; }
      if (a.action === 'pick') await pick(r, a.view ?? e.error?.target ?? 'web');
      else if (a.action === 'highlight') return { matches: await e.highlight(a.view ?? 'web') };
      else if (a.action === 'inspect') { const wc = paneFor(a.view === 'mobile' ? r.mobile : r.web).view.webContents; if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach', title: `Hostframe replay · ${a.view ?? 'web'}` } as any); else wc.devToolsWebContents?.focus(); }
      else if (a.action === 'copy' || a.action === 'reveal') {
        const failure = e.error ?? r.report?.error; if (!failure) throw new AppError('nothing_to_report');
        if (a.action === 'copy') { clipboard.writeText(JSON.stringify(r.report?.error === failure ? r.report.data : failureReport(r, failure), null, 2)); return { copied: true }; }
        if (!failure.report) throw new AppError('report_not_ready');
        shell.showItemInFolder(join(failure.report, 'report.json'));
      }
      else if (a.action === 'speed') { e.speed = a.speed ?? 1; changed(); }
      else e[a.action as 'pause' | 'play' | 'next' | 'previous' | 'retry' | 'skip']();
      return replayState();
    }
    default: throw new AppError('unknown_command');
  }
}

const boundsSchema = z.object({ overlay:z.boolean(), panes:z.array(z.object({ id:z.string(),x:z.number(),y:z.number(),width:z.number(),height:z.number() })).max(100) });
function wireIpc() {
  const check = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => { if(shuttingDown || !win || win.isDestroyed() || event.sender.isDestroyed() || event.sender.id!==win.webContents.id || event.senderFrame!==win.webContents.mainFrame)throw new AppError('unauthorized'); };
  ipcMain.handle('command',async(event,command,params)=>{try{check(event);return {ok:true,result:await dispatch(command,params)};}catch(e){if(!(e instanceof AppError))logLine('command_failed',`${command} ${describe(e)}`);return {ok:false,error:e instanceof AppError?e.code:'operation_failed',detail:e instanceof AppError?undefined:(e instanceof Error?e.message:String(e))};}});
  ipcMain.on('bounds',(event,raw)=>{try{check(event);}catch{return;}const parsed=boundsSchema.safeParse(raw);if(!parsed.success)return;const opening=parsed.data.overlay&&!overlay,closing=!parsed.data.overlay&&overlay;overlay=parsed.data.overlay;
    // Native views draw above the shell, so menus and dialogs hide them. Show a still of each page in its place instead of a blank pane.
    if(opening)freezePanes();else if(closing){overlayGen++;freezing.clear();win.webContents.send('frames',{});}const [width,height]=win.getContentSize();for(const p of panes.values()){if(p.view.webContents.isDestroyed())continue;const b=parsed.data.panes.find(b=>b.id===p.info.id);p.info.visible=!!b&&b.width>=80&&b.height>=60&&b.x>=0&&b.y>=0&&b.x+b.width<=width+2&&b.y+b.height<=height+2;if(p.info.visible&&b)p.view.setBounds({x:Math.round(b.x),y:Math.round(b.y),width:Math.floor(b.width),height:Math.floor(b.height)});if(p.info.visible&&b&&p.info.replay==='mobile')applyMobileScale(p,Math.floor(b.width));p.view.setVisible(p.info.visible&&!p.info.busy&&(!overlay||freezing.has(p.info.id)));}});
  ipcMain.handle('desktop',async(event,action,payload)=>{check(event);
    if(action==='agent-toggle'){agentEnabled=!agentEnabled;changed();return;}
    if(action==='workspace-create'){const name=z.string().max(80).parse(payload);const meta=createWorkspace(name);await activate(meta.id);return meta;}
    if(action==='workspace-switch'){await activate(z.string().parse(payload));return;}
    if(action==='workspace-rename'){const {id,name}=z.object({id:z.string(),name:z.string().min(1).max(80)}).parse(payload);requireValue(workspaces.list.find(w=>w.id===id),'workspace_not_found').name=name.trim();saveWorkspaces();changed();return;}
    if(action==='workspace-delete'){await deleteWorkspace(z.string().parse(payload));return;}
    if(action==='devtools'){const p=paneFor(payload);assertFree(p.info);p.view.webContents.openDevTools({mode:'detach'});return;}
    if(action==='layout'){const validate=(t:any,depth=0):boolean=>depth<16&&t&&(t.type==='leaf'?panes.has(t.paneId):t.type==='split'&&['row','column'].includes(t.direction)&&Number.isFinite(t.ratio)&&t.ratio>=.1&&t.ratio<=.9&&validate(t.first,depth+1)&&validate(t.second,depth+1));if(!validate(payload))throw new AppError('invalid_layout');store.state.layout=payload;store.save();return;}
  });
}
async function seed(demoUrl: string) {
  const fresh = demoMode && !store.state.users.length && !store.state.environments.length;
  if(fresh){store.state.environments=[{id:'local',name:'Local demo',baseUrl:demoUrl,demo:true,recipe:recipeSchema.parse({path:'/login',success:'[data-authenticated]',identity:'[data-identity]'})},{id:'qa',name:'QA',baseUrl:'',recipe:recipeSchema.parse({})},{id:'production',name:'Production',baseUrl:'',recipe:recipeSchema.parse({})}];
    for(const [name,role]of demoUsers){const user={id:uid(),name,role};store.state.users.push(user);const account={id:uid(),userId:user.id,environmentId:'local',label:name};store.state.accounts.push(account);vault.put(account.id,{email:`${name.toLowerCase()}@demo.test`,password:`demo-${name.toLowerCase()}`},0);}
  } else { const demo=store.state.environments.find(e=>e.demo);if(demo){demo.baseUrl=demoUrl;for(const account of store.state.accounts.filter(a=>a.environmentId===demo.id)){const name=store.state.users.find(u=>u.id===account.userId)?.name;const known=demoUsers.find(([n])=>n===name);if(known){try{vault.use(account.id);}catch{vault.put(account.id,{email:`${known[0].toLowerCase()}@demo.test`,password:`demo-${known[0].toLowerCase()}`},vault.status(account.id).revision);}}}} }
  store.save();return fresh;
}
async function start() {
  await app.whenReady();
  if(!safeStorage.isEncryptionAvailable())throw new AppError('os_encryption_unavailable');
  loadWorkspaces();
  win=new BrowserWindow({width:1600,height:1050,minWidth:1000,minHeight:700,show:!smoke,backgroundColor:'#e9e7e1',title:'Hostframe',autoHideMenuBar:true,webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  const shellUrl=pathToFileURL(join(__dirname,'index.html')).href;
  win.webContents.on('will-navigate',(e,url)=>{if(url!==shellUrl)e.preventDefault();});win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  wireIpc();
  // Load the workspace before the shell asks for state, so the first state_get never races the store.
  await activate(workspaces.active);
  await win.loadURL(shellUrl);changed();
  if(smoke){await smokeTest();return;}
  const broker=await startBroker((c,p)=>dispatch(c,p,true));stopBroker=broker.close;
}
async function smokeRecordReplay(owner: ReturnType<typeof paneFor>) {
  const assert=(condition:unknown,message:string)=>{if(!condition)throw new Error(message);};
  const until=async(check:()=>unknown,message:string,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await delay(100);}throw new Error(message);};
  const wc=owner.view.webContents;
  await dispatch('pane_navigate',{paneId:owner.info.id,path:'/app'});await until(()=>!wc.isLoading(),'owner load');
  const { recordingId } = await dispatch('recording_start',{paneId:owner.info.id,name:'Smoke flow'});await delay(300);
  // The shell's grid sizes panes on every state change; record at a desktop width so the nav is not collapsed.
  const click=async(selector:string)=>{owner.view.setBounds({x:0,y:0,width:1000,height:700});await delay(200);const p=await wc.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);wc.sendInputEvent({type:'mouseDown',x:p.x,y:p.y,button:'left',clickCount:1});wc.sendInputEvent({type:'mouseUp',x:p.x,y:p.y,button:'left',clickCount:1});};
  await click('[data-testid=nav-help]');await until(()=>owner.info.url.includes('tab=help')&&!wc.isLoading(),'recorded navigation');await delay(500);
  await click('#note');await delay(150);for(const ch of 'Fix sink')wc.sendInputEvent({type:'char',keyCode:ch});
  wc.sendInputEvent({type:'keyDown',keyCode:'Enter'});wc.sendInputEvent({type:'char',keyCode:'\r'});wc.sendInputEvent({type:'keyUp',keyCode:'Enter'});await delay(400);
  // A portaled dialog: pick an option, save, reopen, then close it by pressing the backdrop.
  const clickAt=(x:number,y:number)=>{wc.sendInputEvent({type:'mouseDown',x,y,button:'left',clickCount:1});wc.sendInputEvent({type:'mouseUp',x,y,button:'left',clickCount:1});};
  await click('[data-testid=open-settings]');await delay(450);
  await click('[role=dialog] h2');await delay(250);
  await click('[role=dialog] label:nth-of-type(2)');await delay(250);
  await click('[role=dialog] footer button:nth-of-type(2)');await delay(450);
  await click('[data-testid=open-settings]');await delay(450);clickAt(20,20);await delay(400);
  assert(await wc.executeJavaScript(`document.querySelector('#trips-mode').textContent==='warehouse'&&!document.querySelector('[role=dialog]')`),'recorded dialog flow');
  const stopped=await dispatch('recording_stop',{});assert(stopped.recordingId===recordingId,'recording id');
  const rec=await dispatch('recording_get',{recordingId});
  assert(rec.steps.map((s:any)=>s.kind).join(',')==='navigate,click,type,key,click,click,check,click,click,dismiss','recorded steps: '+rec.steps.map((s:any)=>s.kind).join(','));
  // Inside a dialog, paths start at the dialog rather than at <body>, where portal order changes between sessions.
  assert(rec.steps[6].selectors[0].startsWith('[role="dialog"] >')&&rec.steps[7].selectors[0].startsWith('[role="dialog"] >')&&!rec.steps[7].fragile,'dialog-anchored selectors '+JSON.stringify([rec.steps[6].selectors,rec.steps[7].selectors]));
  // A click on a heading is noise: kept, but optional, with what was clicked for debugging.
  assert(rec.steps[5].optional&&rec.steps[5].at&&rec.steps[5].target?.tag==='h2'&&rec.steps[7].target?.dialog,'optional click and recorded target '+JSON.stringify([rec.steps[5],rec.steps[7].target]));
  assert(rec.steps[1].selectors[0]==='[data-testid="nav-help"]'&&rec.steps[2].selectors[0]==='#note'&&rec.steps[2].text==='Fix sink'&&rec.steps[2].label==='Test note','language-independent selectors '+JSON.stringify(rec.steps.slice(1,3)));
  rec.steps[2].texts={es:'Arreglar fregadero'};rec.speed=4;await dispatch('recording_save',rec);
  await dispatch('replay_start',{recordingId});
  const r=requireValue(replay,'replay_not_running');
  const web=paneFor(r.web),mobile=paneFor(r.mobile);
  web.view.setBounds({x:0,y:0,width:1000,height:700});web.view.setVisible(true);mobile.view.setBounds({x:1010,y:0,width:300,height:650});mobile.view.setVisible(true);applyMobileScale(mobile,300);
  // A frame from inside the dialog, to see the pointer, fingertip and target ring.
  await until(()=>r.engine.index>=7||!!r.engine.error,'replay reached the dialog',30000).catch(e=>{throw new Error(e.message+' '+JSON.stringify({index:r.engine.index,status:r.engine.status,waiting:[...r.engine.waiting.values()],log:r.engine.log.slice(-4),overlay,vis:[web.view.getVisible(),mobile.view.getVisible()]}));});await delay(Math.round(330/rec.speed)+40);
  for(const p of [web,mobile])writeFileSync(join(process.cwd(),'artifacts',`replay-dialog-${p.info.replay}.png`),(await p.view.webContents.capturePage()).toPNG());
  await until(()=>r.engine.status==='done'||!!r.engine.error,'replay finished',40000);
  assert(!r.engine.error,'replay error: '+JSON.stringify(r.engine.error));
  for(const p of [web,mobile]){
    // The dialog fades out before it is removed.
    await until(()=>p.view.webContents.executeJavaScript(`!document.querySelector('[role=dialog]')`),`${p.info.replay} dialog closed`,3000);
    const seen=await p.view.webContents.executeJavaScript(`({lang:document.documentElement.lang,nav:navigator.language,note:document.querySelector('#note').value,help:!!document.querySelector('#help'),width:innerWidth,trips:document.querySelector('#trips-mode').textContent,dialog:!!document.querySelector('[role=dialog]')})`);
    assert(seen.lang==='es'&&seen.nav.startsWith('es'),`${p.info.replay} language ${JSON.stringify(seen)}`);
    assert(seen.help&&seen.note==='Arreglar fregadero',`${p.info.replay} result ${JSON.stringify(seen)}`);
    assert(seen.trips==='warehouse'&&!seen.dialog,`${p.info.replay} dialog result ${JSON.stringify(seen)}`);
    // On a 393px phone the Help link is only reachable through the collapsed menu.
    if(p===mobile)assert(seen.width===393,'phone viewport '+seen.width);
  }
  // Let the shell lay out the stage (web 3/4 | phone 1/4) and keep pictures of both views.
  changed();await delay(1200);for(const p of [web,mobile])writeFileSync(join(process.cwd(),'artifacts',`replay-${p.info.replay}.png`),(await p.view.webContents.capturePage()).toPNG());
  await dispatch('replay_control',{action:'exit'});assert(!panes.has(r.web)&&!panes.has(r.mobile)&&!replay,'replay cleaned up');
  // A step that cannot work: both views explain why, and a report with screenshots is written.
  const broken={...rec,id:uid(),name:'Smoke failure',steps:[rec.steps[0],{id:uid(),kind:'click',delayMs:300,label:'Ghost',selectors:['#ghost'],fragile:false,texts:{},mobileSkip:false,mobilePre:[]}]};
  await dispatch('recording_save',broken);await dispatch('replay_start',{recordingId:broken.id});
  const f=requireValue(replay,'replay_not_running');
  await until(()=>!!f.engine.error?.report,'failure report',30000);
  const failure=f.engine.error!;
  assert(failure.index===1&&failure.failures.length===2&&failure.failures.every(x=>x.code==='element_not_found'&&x.message.includes('Ghost')&&x.hint&&x.diagnosis?.selectors[0].matches===0),'failure explained '+JSON.stringify(failure));
  assert(['report.json','web.png','mobile.png'].every(n=>existsSync(join(failure.report!,n))),'failure report files');
  assert(failure.failures.every(x=>x.trace?.length&&x.trace.at(-1)!.state==='missing'),'wait trace '+JSON.stringify(failure.failures.map(x=>x.trace)));
  assert(f.engine.log.some(l=>l.index===0&&l.outcome==='ok'),'step log');
  await dispatch('replay_control',{action:'copy'});assert((await clipboard.readText()).includes('"Ghost"'),'report copied');
  // Repair: click the right element in the web view. It replaces the selectors, counts as done on web, and the phone retries with them.
  const fweb=paneFor(f.web);fweb.view.setBounds({x:0,y:0,width:1000,height:700});fweb.view.setVisible(true);await delay(200);
  await dispatch('replay_control',{action:'pick',view:'web'});await delay(200);
  const pt=await fweb.view.webContents.executeJavaScript(`(()=>{const r=document.querySelector('[data-testid=open-settings]').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
  fweb.view.webContents.sendInputEvent({type:'mouseDown',x:pt.x,y:pt.y,button:'left',clickCount:1});fweb.view.webContents.sendInputEvent({type:'mouseUp',x:pt.x,y:pt.y,button:'left',clickCount:1});
  await until(()=>f.engine.status==='done','replay finished after picking',20000);
  assert((await dispatch('recording_get',{recordingId:broken.id})).steps[1].selectors[0]==='[data-testid="open-settings"]','picked selectors saved');
  await dispatch('replay_control',{action:'exit'});
}
async function smokeTest(){
  const assert=(condition:unknown,message:string)=>{if(!condition)throw new Error(message);};
  const owner=[...panes.values()][0],driver=[...panes.values()][1];
  await dispatch('auth_login',{paneId:owner.info.id});await dispatch('auth_login',{paneId:driver.info.id});
  assert((await dispatch('page_snapshot',{paneId:owner.info.id})).text.includes('Jordan'),'owner identity');
  assert((await dispatch('page_snapshot',{paneId:driver.info.id})).text.includes('Alex'),'driver identity');
  await dispatch('page_click',{paneId:owner.info.id,selector:'#job-action'});await delay(250);
  await dispatch('page_click',{paneId:driver.info.id,selector:'#job-action'});
  const refreshedBy=Date.now()+8000;
  while(Date.now()<refreshedBy && !(await dispatch('page_snapshot',{paneId:owner.info.id})).text.includes('Accepted'))await delay(200);
  assert((await dispatch('page_snapshot',{paneId:owner.info.id})).text.includes('Accepted'),'cross-user state');
  const copy=await dispatch('pane_copy',{paneId:driver.info.id,temporary:true});
  const temp=paneFor(copy.paneId);assert(temp.view.webContents.session!==driver.view.webContents.session,'isolated session');
  assert((await temp.view.webContents.session.cookies.get({})).length===0,'fresh temporary cookies');
  await dispatch('auth_login',{paneId:copy.paneId});
  const status=await dispatch('credentials_status',{accountId:driver.info.accountId,temporaryId:copy.temporaryId});
  await dispatch('credentials_put',{accountId:driver.info.accountId,temporaryId:copy.temporaryId,email:'private-test@example.test',password:'private-test-only',expectedRevision:status.revision});
  assert(vault.status(driver.info.accountId).revision===1,'source credentials untouched');
  await dispatch('temporary_delete',{temporaryId:copy.temporaryId});assert(!panes.has(copy.paneId),'copy destroyed');
  win.showInactive();await delay(300);
  owner.view.setBounds({x:0,y:0,width:700,height:600});owner.view.setVisible(true);owner.info.visible=true;overlay=false;
  const screenshot=await dispatch('capture',{paneId:owner.info.id});assert(screenshot.image.length>1000,'PNG capture');
  mkdirSync(join(process.cwd(),'artifacts'),{recursive:true});writeFileSync(join(process.cwd(),'artifacts','smoke.png'),Buffer.from(screenshot.image,'base64'));
  let blocked=false;try{await dispatch('pane_navigate',{paneId:owner.info.id,path:'https://example.com'});}catch{blocked=true;}assert(blocked,'origin restriction');
  // A menu hides the live views; each pane must show a still of its page rather than going blank.
  changed();await delay(600);
  await win.webContents.executeJavaScript(`document.querySelector('[data-tool=gear]').click()`);
  const frozenOk=async()=>win.webContents.executeJavaScript(`[...document.querySelectorAll('[data-surface]')].some(e=>e.classList.contains('frozen')&&e.style.backgroundImage.startsWith('url("data:image/jpeg'))`);
  const until2=async(check:()=>Promise<unknown>,ms:number)=>{const end=Date.now()+ms;while(Date.now()<end){if(await check())return true;await delay(80);}return false;};
  assert(await until2(frozenOk,3000)&&!owner.view.getVisible(),'menu shows a still of the page');
  await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
  assert(await until2(async()=>owner.view.getVisible()&&!(await frozenOk()),3000),'live view back after the menu closes');
  await checkAuthRedirects(dispatch);
  await smokeRecordReplay(owner);
  writeFileSync(join(process.cwd(),'artifacts','smoke-result.json'),JSON.stringify({passed:true,checks:['seven panes','independent identities','cross-user state','fresh temporary session','copy-on-write credentials','temporary deletion','PNG capture','origin restriction','hosted auth redirect round trip','unlisted auth redirect denied','no credential fill on auth provider','email-first password login','password-step origin recheck','record flow without text selectors','replay web | mobile in Spanish','mobile menu revealed automatically','per-language typed text','dialog steps anchored to the dialog','dialog closed by backdrop replays','failures explained with a saved report','noise clicks optional with recorded target','wait trace and step log','repair by picking the element','menus show a still instead of a blank pane']},null,2));
  app.quit();
}
app.on('before-quit',()=>{shuttingDown=true;stopBroker?.();stopDemo?.();for(const p of panes.values()){if(!p.view.webContents.isDestroyed())p.view.webContents.close({waitForBeforeUnload:false});}});
app.on('window-all-closed',()=>app.quit());
app.on('second-instance',()=>{if(win&&!win.isDestroyed()){win.show();win.focus();}});
if(single)start().catch((error)=>{shuttingDown=true;if(smoke){mkdirSync(join(process.cwd(),'artifacts'),{recursive:true});writeFileSync(join(process.cwd(),'artifacts','smoke-result.json'),JSON.stringify({passed:false,error:error instanceof Error?error.message:'startup_or_smoke_failed',stack:error instanceof Error?error.stack:undefined}));}else{console.error('Hostframe startup:',error instanceof Error?error.message:'startup_failed');}process.exitCode=1;app.exit(1);});
