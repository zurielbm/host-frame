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
    const role = name && demoUsers.find(([n]) => n === name)?.[1];
    const style = `<style>body{background:#edf0e8;color:#25382a;font:14px/1.6 system-ui;padding:22px;margin:0}h1{font-size:25px;letter-spacing:-1px}small{color:#66735f}input,button{font:inherit;padding:10px;border-radius:6px;border:1px solid #bac8b3;box-sizing:border-box}input{display:block;width:100%;margin:8px 0 16px;background:#f5f6f0}button{background:#354f3b;color:#ecf3e5;cursor:pointer}article{background:#e1e7d9;border:1px solid #c9d4bf;padding:16px;border-radius:9px;margin:20px 0}header{display:flex;justify-content:space-between;font-size:11px}a{color:#476c39}code{font-size:11px}</style>`;
    if (!name || route === '/login') { res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Dispatch demo · sign in</title>${style}<header>DISPATCH / LOCAL DEMO</header><h1>Welcome back.</h1><p>This is the included test app.</p><form method="post" action="/login"><label>Email<input type="email" name="email" autocomplete="off" required></label><label>Password<input type="password" name="password" autocomplete="off" required></label><button type="submit">Sign in</button></form><p><small>Use the browser’s Login button to fill this user’s saved demo credentials.</small></p></html>`); return; }
    const action = role === 'Owner' ? 'Assign to Alex' : role === 'Driver' ? 'Accept job' : role === 'Intaker' ? 'Create intake' : '';
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Dispatch · ${name}</title>${style}<header>↗ DISPATCH <a href="/logout">Sign out</a></header><main data-authenticated><h1>Hello, <span data-identity>${name}</span>.</h1><small>${role || 'User'} workspace · isolated login</small><article><small>JOB-1042</small><h2>${job.name}</h2><p>Status: <strong id="status">${job.status}</strong></p>${action ? `<button id="job-action">${action}</button>` : '<p>Read-only overview</p>'}</article><label>Test note<input id="note" placeholder="An ordinary field agents can fill"></label><p><small>Owner assigns → Driver accepts → Owner sees the update.</small></p></main><script>async function refresh(){const r=await fetch('/api/job');if(r.ok)document.querySelector('#status').textContent=(await r.json()).status}document.querySelector('#job-action')?.addEventListener('click',async()=>{await fetch('/api/job',{method:'POST'});refresh()});setInterval(refresh,1200)</script></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('demo_start_failed');
  return { url: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}
