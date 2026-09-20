import { app, BrowserWindow, WebContentsView, ipcMain, safeStorage, session } from 'electron';
import { join } from 'node:path';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Account, AppError, Command, Pane, Split, allowedUrl, normalizeOrigins, recipeSchema, requireValue, sessionKey, specs } from './contracts';
import { Store, Vault, atomicJson, uid } from './store';
import { balancedLayout, removePane } from './layout';
import { demoUsers, startDemo } from './demo';
import { startBroker } from './broker';
import { checkAuthRedirects } from './auth-redirect-smoke';

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
let overlay = false;
let shuttingDown = false;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function logLine(kind: string, detail: string) { try { const line = `${new Date().toISOString()} ${kind} ${detail}\n`; process.stderr.write(line); writeFileSync(join(app.getPath('userData'), 'hostframe.log'), line, { flag: 'a' }); } catch {} }
const describe = (e: unknown) => e instanceof Error ? `${e.message}${e.stack ? ' | ' + e.stack.split('\n').slice(1, 3).join(' ').trim() : ''}` : String(e);
const paneFor = (id: string) => requireValue(panes.get(id),'pane_not_found');
const accountFor = (id: string) => requireValue(store.state.accounts.find(a => a.id === id),'account_not_found');
const envFor = (account: Account) => requireValue(store.state.environments.find(e => e.id === account.environmentId),'environment_not_found');
const safeUrl = (url: string) => { try { const u = new URL(url); return u.origin + u.pathname; } catch { return ''; } };
function state() { return { ...store.state, workspaces, panes: [...panes.values()].map(p => ({ ...p.info, url: safeUrl(p.info.url), title: '' })), credentials: store.state.accounts.map(a => ({ accountId: a.id, ...vault.status(a.id) })), agentEnabled }; }
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
function updateLayout() { store.state.layout = balancedLayout([...panes.keys()]); store.save(); changed(); }
async function openPane(accountId: string, path = '/', temporaryId?: string, restoredId?: string) {
  const account = accountFor(accountId), env = envFor(account); const url = allowedUrl(path, env.baseUrl, env.allowedOrigins || []);
  const key = sessionKey(accountId,temporaryId);
  const ses = session.fromPartition(key);
  ses.setPermissionRequestHandler((_wc,_permission,callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  // Downloads have a separate lifecycle; deny until tracked cleanup is implemented.
  if (ses.listenerCount('will-download') === 0) ses.on('will-download', e => e.preventDefault());
  const view = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: true } });
  const info: Pane = { id: restoredId || uid(), accountId, temporaryId, sessionKey: key, url, title: '', busy: false, visible: false, devtools: false };
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
  updateLayout();
  try { await view.webContents.loadURL(url); } catch { /* Keep the pane available for URL correction/retry. */ }
  savePanes(); changed(); return { paneId: info.id, temporaryId, sessionKey: key };
}
function closeAll() { for (const p of panes.values()) { win.contentView.removeChildView(p.view); if (!p.view.webContents.isDestroyed()) p.view.webContents.close({ waitForBeforeUnload: false }); } panes.clear(); locks.clear(); }
async function activate(id: string) {
  const meta = requireValue(workspaces.list.find(w => w.id === id), 'workspace_not_found');
  if (store) { for (const p of panes.values()) assertFree(p.info); savePanes(); closeAll(); }
  workspaces.active = meta.id; saveWorkspaces();
  store = new Store(wsDir(meta.id)); vault = new Vault(store.directory, v => safeStorage.encryptString(v), v => safeStorage.decryptString(v));
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
    try { if (await p.view.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&e.getClientRects().length>0})()`)) return; } catch { /* Navigation can replace the execution context. */ }
    await delay(120);
  }
  throw new AppError('selector_timeout');
}
function isLoginPage(p: ReturnType<typeof paneFor>) {
  const env = envFor(accountFor(p.info.accountId));
  return new URL(p.info.url).pathname === new URL(env.recipe.path,env.baseUrl).pathname;
}
async function login(p: ReturnType<typeof paneFor>) {
  const account = accountFor(p.info.accountId), env = envFor(account); const recipe = env.recipe;
  return exclusive(p.info, async () => {
    // Hide all views sharing this identity while a secret is in the renderer.
    for (const sibling of panes.values()) if (sibling.info.sessionKey === p.info.sessionKey) sibling.view.setVisible(false);
    let phase = 'vault';
    try {
      const pair = vault.use(account.id,p.info.temporaryId);
      phase = 'navigation';
      await p.view.webContents.loadURL(allowedUrl(recipe.path,env.baseUrl));
      phase = 'fields';
      await waitVisible(p,recipe.email,8000);
      phase = 'submission';
      const result = await p.view.webContents.executeJavaScript(`(()=>{
        if(location.origin!==${JSON.stringify(new URL(env.baseUrl).origin)})return false;
        const a=document.querySelector(${JSON.stringify(recipe.email)}), b=document.querySelector(${JSON.stringify(recipe.password)}), c=document.querySelector(${JSON.stringify(recipe.submit)});
        if(!(a instanceof HTMLInputElement)||!(b instanceof HTMLInputElement)||!c)return false;
        const form=b.form;if(form&&new URL(form.action||location.href,location.href).origin!==location.origin)return false;
        const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
        set.call(a,${JSON.stringify(pair.email)});a.dispatchEvent(new Event('input',{bubbles:true}));a.dispatchEvent(new Event('change',{bubbles:true}));
        set.call(b,${JSON.stringify(pair.password)});b.dispatchEvent(new Event('input',{bubbles:true}));b.dispatchEvent(new Event('change',{bubbles:true}));c.click();return true;
      })()`);
      pair.email = ''; pair.password = '';
      if (!result) throw new AppError('login_recipe_mismatch');
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
    default: throw new AppError('unknown_command');
  }
}

const boundsSchema = z.object({ overlay:z.boolean(), panes:z.array(z.object({ id:z.string(),x:z.number(),y:z.number(),width:z.number(),height:z.number() })).max(100) });
function wireIpc() {
  const check = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => { if(shuttingDown || !win || win.isDestroyed() || event.sender.isDestroyed() || event.sender.id!==win.webContents.id || event.senderFrame!==win.webContents.mainFrame)throw new AppError('unauthorized'); };
  ipcMain.handle('command',async(event,command,params)=>{try{check(event);return {ok:true,result:await dispatch(command,params)};}catch(e){if(!(e instanceof AppError))logLine('command_failed',`${command} ${describe(e)}`);return {ok:false,error:e instanceof AppError?e.code:'operation_failed',detail:e instanceof AppError?undefined:(e instanceof Error?e.message:String(e))};}});
  ipcMain.on('bounds',(event,raw)=>{try{check(event);}catch{return;}const parsed=boundsSchema.safeParse(raw);if(!parsed.success)return;overlay=parsed.data.overlay;const [width,height]=win.getContentSize();for(const p of panes.values()){if(p.view.webContents.isDestroyed())continue;const b=parsed.data.panes.find(b=>b.id===p.info.id);p.info.visible=!!b&&b.width>=80&&b.height>=60&&b.x>=0&&b.y>=0&&b.x+b.width<=width+2&&b.y+b.height<=height+2;if(p.info.visible&&b)p.view.setBounds({x:Math.round(b.x),y:Math.round(b.y),width:Math.floor(b.width),height:Math.floor(b.height)});p.view.setVisible(p.info.visible&&!overlay&&!p.info.busy);}});
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
  await checkAuthRedirects(dispatch);
  writeFileSync(join(process.cwd(),'artifacts','smoke-result.json'),JSON.stringify({passed:true,checks:['seven panes','independent identities','cross-user state','fresh temporary session','copy-on-write credentials','temporary deletion','PNG capture','origin restriction','hosted auth redirect round trip','unlisted auth redirect denied','no credential fill on auth provider']},null,2));
  app.quit();
}
app.on('before-quit',()=>{shuttingDown=true;stopBroker?.();stopDemo?.();for(const p of panes.values()){if(!p.view.webContents.isDestroyed())p.view.webContents.close({waitForBeforeUnload:false});}});
app.on('window-all-closed',()=>app.quit());
app.on('second-instance',()=>{if(win&&!win.isDestroyed()){win.show();win.focus();}});
if(single)start().catch((error)=>{shuttingDown=true;if(smoke){mkdirSync(join(process.cwd(),'artifacts'),{recursive:true});writeFileSync(join(process.cwd(),'artifacts','smoke-result.json'),JSON.stringify({passed:false,error:error instanceof Error?error.message:'startup_or_smoke_failed',stack:error instanceof Error?error.stack:undefined}));}else{console.error('Hostframe startup:',error instanceof Error?error.message:'startup_failed');}process.exitCode=1;app.exit(1);});
