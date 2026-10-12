import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
export const demoUsers = [['Jordan','Owner'],['Alex','Driver'],['Sam','Intaker'],['Casey','Dispatcher'],['Morgan','Billing'],['Riley','Manager'],['Jamie','']] as const;
export async function startDemo() {
  const sessions = new Map<string, string>();
  let job = { status: 'New', name: 'Riverside pickup' };
  const server = createServer(async (req, res) => {
    const route = new URL(req.url || '/', 'http://localhost').pathname;
    const cookie = req.headers.cookie?.match(/(?:^|;\s*)rf_demo=([^;]+)/)?.[1];
    const name = cookie && sessions.get(cookie);
    res.setHeader('Cache-Control','no-store');
    if (route === '/login' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 16000) { res.writeHead(413).end(); return; } }
      const params = new URLSearchParams(body);
      const found = demoUsers.find(([n]) => params.get('email') === `${n.toLowerCase()}@demo.test` && params.get('password') === `demo-${n.toLowerCase()}`);
      if (found) { const token = randomUUID(); sessions.set(token, found[0]); res.setHeader('Set-Cookie', `rf_demo=${token}; HttpOnly; SameSite=Strict; Path=/`); res.writeHead(303, { Location: '/app' }).end(); }
      else { res.writeHead(303, { Location: '/login?failed=1' }).end(); } return;
    }
    if (route === '/logout') { if (cookie) sessions.delete(cookie); res.setHeader('Set-Cookie','rf_demo=; Max-Age=0; HttpOnly; Path=/'); res.writeHead(303,{Location:'/login'}).end(); return; }
    if (route === '/api/job') {
      if (!name) { res.writeHead(401).end(); return; }
      if (req.method === 'POST') {
        const role = demoUsers.find(([n]) => n === name)?.[1];
        if (role === 'Owner') job.status = 'Assigned'; else if (role === 'Driver' && job.status === 'Assigned') job.status = 'Accepted'; else if (role === 'Intaker') job.status = 'New'; else { res.writeHead(403).end(); return; }
      }
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(job)); return;
    }
    res.setHeader('Content-Type','text/html; charset=utf-8');
    // Follows Accept-Language so recorded English flows can be replayed in Spanish.
    const es = /^es\b/i.test(String(req.headers['accept-language'] || ''));
    const t = (en: string, sp: string) => es ? sp : en;
    const htmlLang = es ? 'es' : 'en';
    const role = name && demoUsers.find(([n]) => n === name)?.[1];
    const style = `<style>body{background:#edf0e8;color:#25382a;font:14px/1.6 system-ui;padding:22px;margin:0}h1{font-size:25px;letter-spacing:-1px}small{color:#66735f}input,button{font:inherit;padding:10px;border-radius:6px;border:1px solid #bac8b3;box-sizing:border-box}input{display:block;width:100%;margin:8px 0 16px;background:#f5f6f0}button{background:#354f3b;color:#ecf3e5;cursor:pointer}article{background:#e1e7d9;border:1px solid #c9d4bf;padding:16px;border-radius:9px;margin:20px 0}header{display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:11px}nav{display:flex;gap:12px;align-items:center}#menu{display:flex;gap:12px}#menu-btn{display:none;padding:4px 10px}@media(max-width:600px){#menu-btn{display:inline-block}#menu{display:none}#menu.open{display:flex;flex-direction:column;position:absolute;top:52px;right:22px;background:#e1e7d9;border:1px solid #c9d4bf;border-radius:8px;padding:10px 14px}}a{color:#476c39}code{font-size:11px}.ov{position:fixed;inset:0;background:rgba(20,30,20,.45);animation:fade .2s}.dlg{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(420px,calc(100vw - 32px));background:#f5f6f0;border-radius:12px;padding:18px;box-shadow:0 20px 50px rgba(0,0,0,.3);animation:zoom .22s ease-out}.dlg.out,.ov.out{opacity:0;transition:opacity .16s}.opt{display:block;position:relative;border:1px solid #bac8b3;border-radius:8px;padding:10px 12px;margin:8px 0;cursor:pointer}.opt:has(:checked){border-color:#354f3b;box-shadow:0 0 0 1px #354f3b}.sr{position:absolute;opacity:0;width:1px;height:1px;margin:0}.dlg footer{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}@keyframes fade{from{opacity:0}}@keyframes zoom{from{opacity:0;transform:translate(-50%,-50%) scale(.92)}}</style>`;
    if (!name || route === '/login') { res.end(`<!doctype html><html lang="${htmlLang}"><meta charset="utf-8"><title>Dispatch demo · sign in</title>${style}<header>DISPATCH / LOCAL DEMO</header><h1>${t('Welcome back.','Bienvenido de nuevo.')}</h1><p>${t('This is the included test app.','Esta es la aplicación de prueba incluida.')}</p><form method="post" action="/login"><label>${t('Email','Correo')}<input type="email" name="email" autocomplete="off" required></label><label>${t('Password','Contraseña')}<input type="password" name="password" autocomplete="off" required></label><button type="submit">${t('Sign in','Iniciar sesión')}</button></form><p><small>${t('Use the browser’s Login button to fill this user’s saved demo credentials.','Usa el botón de inicio de sesión del navegador para rellenar las credenciales guardadas.')}</small></p></html>`); return; }
    const action = role === 'Owner' ? t('Assign to Alex','Asignar a Alex') : role === 'Driver' ? t('Accept job','Aceptar trabajo') : role === 'Intaker' ? t('Create intake','Crear ingreso') : '';
    const help = new URL(req.url || '/', 'http://localhost').searchParams.get('tab') === 'help';
    const nav = `<nav><button id="menu-btn" type="button" aria-controls="menu" aria-expanded="false" aria-label="${t('Menu','Menú')}">☰</button><span id="menu"><a href="/app" data-testid="nav-home">${t('Jobs','Trabajos')}</a><a href="/app?tab=help" data-testid="nav-help">${t('Help','Ayuda')}</a><a href="/logout">${t('Sign out','Cerrar sesión')}</a></span></nav>`;
    res.end(`<!doctype html><html lang="${htmlLang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dispatch · ${name}</title>${style}<header>↗ DISPATCH ${nav}</header><main data-authenticated><h1>${t('Hello','Hola')}, <span data-identity>${name}</span>.</h1><small>${role || t('User','Usuario')} · ${t('isolated login','sesión aislada')}</small>${help ? `<article id="help"><h2>${t('Help','Ayuda')}</h2><p>${t('Owners assign jobs; drivers accept them.','Los propietarios asignan trabajos; los conductores los aceptan.')}</p></article>` : ''}<article><small>JOB-1042</small><h2>${job.name}</h2><p>${t('Status','Estado')}: <strong id="status">${job.status}</strong></p>${action ? `<button id="job-action">${action}</button>` : `<p>${t('Read-only overview','Vista de solo lectura')}</p>`}</article><p><button type="button" data-testid="open-settings">${t('Trip settings','Ajustes de viajes')}</button> <small>${t('Trips','Viajes')}: <strong id="trips-mode">simple</strong></small></p><label>${t('Test note','Nota de prueba')}<input id="note" placeholder="${t('An ordinary field agents can fill','Un campo normal que los agentes pueden rellenar')}"></label><p><small>${t('Owner assigns → Driver accepts → Owner sees the update.','El propietario asigna → el conductor acepta → el propietario ve el cambio.')}</small></p></main><script>
// Like a Radix/shadcn dialog: portaled to the end of <body> next to a varying number of other portals, with a generated id and an open animation.
for(let i=Math.floor(Math.random()*3);i>0;i--)document.body.appendChild(document.createElement('div'));
const T=${JSON.stringify({ title: t('Trips', 'Viajes'), simple: t('Simple', 'Simple'), warehouse: t('With warehouse stops', 'Con paradas en almacén'), cancel: t('Cancel', 'Cancelar'), save: t('Save settings', 'Guardar ajustes') })};
function closeSettings(){const els=document.querySelectorAll('.ov,.dlg');els.forEach(e=>e.classList.add('out'));setTimeout(()=>els.forEach(e=>e.remove()),170);document.removeEventListener('keydown',onKey);}
function onKey(e){if(e.key==='Escape')closeSettings();}
document.querySelector('[data-testid=open-settings]').addEventListener('click',()=>{const mode=document.querySelector('#trips-mode').textContent;
  const ov=document.createElement('div');ov.className='ov';ov.addEventListener('pointerdown',closeSettings);
  const d=document.createElement('div');d.className='dlg';d.setAttribute('role','dialog');d.setAttribute('aria-modal','true');d.id='radix-«r'+Math.random().toString(36).slice(2,5)+'»';
  d.innerHTML='<h2>'+T.title+'</h2><div>'+['simple','warehouse'].map(v=>'<label class="opt"><input class="sr" type="radio" name="trips" value="'+v+'"'+(v===mode?' checked':'')+'> '+T[v]+'</label>').join('')+'</div><footer><button type="button">'+T.cancel+'</button><button type="button">'+T.save+'</button></footer>';
  const [cancel,save]=d.querySelectorAll('footer button');cancel.addEventListener('click',closeSettings);
  save.addEventListener('click',()=>{document.querySelector('#trips-mode').textContent=d.querySelector(':checked').value;closeSettings();});
  document.body.append(ov,d);document.addEventListener('keydown',onKey);});
document.querySelector('#menu-btn').addEventListener('click',e=>{const open=document.querySelector('#menu').classList.toggle('open');e.currentTarget.setAttribute('aria-expanded',String(open));});async function refresh(){const r=await fetch('/api/job');if(r.ok)document.querySelector('#status').textContent=(await r.json()).status}document.querySelector('#job-action')?.addEventListener('click',async()=>{await fetch('/api/job',{method:'POST'});refresh()});setInterval(refresh,1200)</script></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('demo_start_failed');
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}
