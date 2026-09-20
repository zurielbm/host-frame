import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import { recipeSchema } from './contracts';

// Invoked only by --smoke-test, using disposable profiles and local fixtures.
export async function checkAuthRedirects(dispatch: (command: string, params: unknown) => Promise<any>) {
  let base = '', provider = '', providerSubmissions = 0;
  const form = '<form method="post"><input type="email"><input type="password"><button type="submit">Sign in</button></form>';
  const auth = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'POST') providerSubmissions++;
    if (req.url?.startsWith('/handshake')) {
      res.writeHead(302, { Location: base + '/form', 'Set-Cookie': 'handshake=ok; HttpOnly; SameSite=Lax; Path=/' }).end();
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end(form);
    }
  });
  const site = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/login') res.writeHead(302, { Location: provider + '/handshake?return_to=' + encodeURIComponent(base + '/form') }).end();
    else if (req.url === '/blocked') res.writeHead(302, { Location: provider.replace('127.0.0.1', 'localhost') + '/handshake' }).end();
    else if (req.url === '/foreign-form') res.writeHead(302, { Location: provider + '/form' }).end();
    else {
      res.setHeader('Content-Type', 'text/html');
      res.end(req.method === 'POST' ? '<main data-authenticated>Signed in</main>' : form);
    }
  });
  const listen = async (server: Server) => {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    assert(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
  };
  const close = async (server: Server) => {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  };
  try {
    base = await listen(site); provider = await listen(auth);
    const environment = { id: 'redirect-smoke', name: 'Redirect smoke', baseUrl: base, recipe: recipeSchema.parse({ path: '/login', success: '[data-authenticated]' }), allowedOrigins: [] as string[] };
    await dispatch('environment_save', environment);
    const user = await dispatch('user_create', { name: 'Redirect smoke' });
    const account = await dispatch('account_create', { userId: user.id, environmentId: environment.id, label: user.name });
    await dispatch('credentials_put', { accountId: account.id, email: 'redirect@example.test', password: 'local-fixture-only', expectedRevision: 0 });
    const { paneId } = await dispatch('pane_open', { accountId: account.id, path: '/login' });
    const pane = async () => (await dispatch('state_get', {})).panes.find((p: { id: string }) => p.id === paneId);
    assert.equal((await pane()).blocked, provider, 'unlisted handshake is blocked');

    environment.allowedOrigins = [provider];
    await dispatch('environment_save', environment);
    const result = await dispatch('auth_login', { paneId });
    assert.equal(result.outcome, 'success_marker_observed', 'allowlisted handshake returns to the app and login succeeds');
    assert.equal((await pane()).blocked, undefined, 'successful retry clears blocked state');
    assert.equal((await pane()).url, base + '/form');

    await dispatch('pane_navigate', { paneId, path: provider + '/handshake' });
    assert.equal((await pane()).url, base + '/form', 'direct navigation uses the same allowlist');
    await assert.rejects(dispatch('pane_navigate', { paneId, path: '/blocked' }));
    assert.equal((await pane()).blocked, provider.replace('127.0.0.1', 'localhost'), 'allowing a provider does not allow other hosts');

    environment.recipe.path = '/foreign-form';
    await dispatch('environment_save', environment);
    await assert.rejects(dispatch('auth_login', { paneId }), /login_recipe_mismatch/, 'navigation permission does not grant credential filling permission');
    assert.equal(providerSubmissions, 0, 'provider form never receives credentials');
    await dispatch('account_delete', { accountId: account.id });
    await dispatch('user_delete', { userId: user.id });
  } finally {
    await close(site); await close(auth);
  }
}
