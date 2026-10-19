import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import modernCallback from '../netlify/functions/google-auth-callback.mts';

const require = createRequire(import.meta.url);
const { handler: legacyCallback } = require('../netlify/functions/google-auth-callback.js');
const clientSecret = 'fixture-oauth-secret';

async function connect(t, implementation, files, { renameFails = false } = {}) {
  const originalFetch = globalThis.fetch;
  const originalNetlify = globalThis.Netlify;
  const environment = {
    GOOGLE_CLIENT_ID: 'fixture-client',
    GOOGLE_CLIENT_SECRET: clientSecret,
    OS4_SESSION_SECRET: 'fixture-session-secret',
    ALLOWED_GOOGLE_EMAIL: 'owner@example.test',
  };
  const previousEnvironment = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]));
  Object.assign(process.env, environment);
  globalThis.Netlify = { env: { get: name => environment[name] } };
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.Netlify = originalNetlify;
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = options.method || 'GET';
    if (url.hostname === 'oauth2.googleapis.com') {
      assert.equal(new URLSearchParams(options.body).get('redirect_uri'), 'https://os4cortes.netlify.app/api/google-drive/callback');
      return Response.json({ access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token' });
    }
    if (url.hostname === 'openidconnect.googleapis.com') {
      return Response.json({ sub: 'fixture-owner', email: 'owner@example.test', name: 'Owner' });
    }
    assert.equal(url.hostname, 'www.googleapis.com');
    assert.equal(options.headers.Authorization, 'Bearer fixture-access-token');
    calls.push({ method, url, body: options.body ? JSON.parse(options.body) : null });
    if (method === 'GET' && url.pathname === '/drive/v3/files') {
      const query = url.searchParams.get('q');
      assert.match(query, /name = 'OS4 de Direita' or name = 'OS4 Cortes'/);
      assert.match(query, /mimeType = 'application\/vnd.google-apps.folder' and trashed = false/);
      return Response.json({ files });
    }
    if (method === 'PATCH') {
      assert.deepEqual(JSON.parse(options.body), { name: 'OS4 de Direita' });
      return renameFails
        ? Response.json({ error: 'fixture rename forbidden' }, { status: 403 })
        : Response.json({ id: url.pathname.split('/').at(-1), name: 'OS4 de Direita' });
    }
    if (method === 'POST' && url.pathname === '/drive/v3/files') {
      assert.deepEqual(JSON.parse(options.body), { name: 'OS4 de Direita', mimeType: 'application/vnd.google-apps.folder' });
      return Response.json({ id: 'created-folder', name: 'OS4 de Direita' });
    }
    if (method === 'POST' && url.pathname.endsWith('/permissions')) {
      assert.deepEqual(JSON.parse(options.body), { role: 'reader', type: 'anyone' });
      return Response.json({ id: 'fixture-permission' });
    }
    assert.fail(`Unexpected Drive request: ${method} ${url.pathname}`);
  };

  const timestamp = String(Date.now());
  const signature = crypto.createHmac('sha256', clientSecret).update(timestamp).digest('hex');
  const state = Buffer.from(`${timestamp}.${signature}`).toString('base64url');
  let folderId;
  if (implementation === 'modern') {
    const response = await modernCallback(new Request(`https://os4cortes.netlify.app/api/google-drive/callback?code=fixture-code&state=${state}`));
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Google Drive conectado — OS4 de Direita/);
    folderId = html.match(/id="folder" readonly value="([^"]+)"/)[1];
  } else {
    const response = await legacyCallback({
      queryStringParameters: { code: 'fixture-code', state },
      headers: { host: 'os4cortes.netlify.app' },
    });
    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.Location, '/?login=ok');
    const setupCookie = response.multiValueHeaders['Set-Cookie'].find(cookie => cookie.startsWith('os4_setup='));
    folderId = JSON.parse(decodeURIComponent(setupCookie.split(';')[0].slice('os4_setup='.length))).folderId;
  }
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/permissions')).length, 1);
  assert.equal(calls.find(call => call.url.pathname.endsWith('/permissions')).url.pathname, `/drive/v3/files/${folderId}/permissions`);
  return { calls, folderId };
}

for (const implementation of ['legacy', 'modern']) {
  test(`${implementation} callback renames the legacy folder and preserves its ID`, async t => {
    const { calls, folderId } = await connect(t, implementation, [{ id: 'existing-folder', name: 'OS4 Cortes' }]);
    assert.equal(folderId, 'existing-folder');
    assert.equal(calls.filter(call => call.method === 'PATCH').length, 1);
    assert.equal(calls.find(call => call.method === 'PATCH').url.pathname, '/drive/v3/files/existing-folder');
    assert.equal(calls.some(call => call.method === 'POST' && call.url.pathname === '/drive/v3/files'), false);
  });

  test(`${implementation} callback prefers the current folder when both names exist`, async t => {
    const { calls, folderId } = await connect(t, implementation, [
      { id: 'legacy-folder', name: 'OS4 Cortes' },
      { id: 'current-folder', name: 'OS4 de Direita' },
    ]);
    assert.equal(folderId, 'current-folder');
    assert.equal(calls.some(call => call.method === 'PATCH'), false);
    assert.equal(calls.some(call => call.method === 'POST' && call.url.pathname === '/drive/v3/files'), false);
  });

  test(`${implementation} callback creates a current-brand folder only when none exists`, async t => {
    const { calls, folderId } = await connect(t, implementation, []);
    assert.equal(folderId, 'created-folder');
    assert.equal(calls.filter(call => call.method === 'POST' && call.url.pathname === '/drive/v3/files').length, 1);
    assert.equal(calls.some(call => call.method === 'PATCH'), false);
  });

  test(`${implementation} callback preserves the existing folder when renaming fails`, async t => {
    const { calls, folderId } = await connect(t, implementation, [{ id: 'existing-folder', name: 'OS4 Cortes' }], { renameFails: true });
    assert.equal(folderId, 'existing-folder');
    assert.equal(calls.filter(call => call.method === 'PATCH').length, 1);
    assert.equal(calls.some(call => call.method === 'POST' && call.url.pathname === '/drive/v3/files'), false);
  });
}
