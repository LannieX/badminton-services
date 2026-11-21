import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../src/worker.mjs';
const env = {
  DATABASE_URL: 'postgresql://unused@invalid/db',
  ALLOWED_ORIGINS: 'http://localhost:5173,https://ibadz.example',
};
function setup({ fail = false, role = 'admin' } = {}) {
  let opened = 0,
    closed = 0;
  const pending = [];
  const worker = createWorker(() => {
    opened++;
    return {
      on() {},
      async query(sql) {
        if (fail) throw new Error('private-database-details');
        if (sql.startsWith('UPDATE rally_auth_sessions'))
          return { rows: [{ id: '11111111-1111-4111-8111-111111111111', role, status: 'active' }] };
        return { rows: [] };
      },
      async end() {
        closed++;
      },
    };
  });
  return {
    async call(path, options = {}, environment = env) {
      const response = await worker.fetch(
        new Request('https://api.example' + path, {
          ...options,
          headers: { 'X-Requested-With': 'ibadz', ...options.headers },
        }),
        environment,
        { waitUntil: (p) => pending.push(p) },
      );
      await Promise.all(pending);
      return response;
    },
    get opened() {
      return opened;
    },
    get closed() {
      return closed;
    },
  };
}
const cookie = { Cookie: 'ibadz_session=' + '1'.repeat(64) };
test('Worker requires authenticated sessions for all data and admin for writes', async () => {
  const app = setup();
  for (const path of ['/api/sessions', '/api/players', '/api/auth/me'])
    assert.equal((await app.call(path)).status, 401);
  assert.equal((await app.call('/api/players', { headers: cookie })).status, 200);
  assert.equal((await app.call('/api/players', {}, { ...env, DATABASE_URL: '' })).status, 503);
  const viewer = setup({ role: 'viewer' });
  assert.equal(
    (
      await viewer.call('/api/players', {
        method: 'POST',
        headers: { ...cookie, 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
});
test('Worker rejects unknown origins before DB access and supports credentialed preflight', async () => {
  const app = setup();
  assert.equal(
    (await app.call('/api/players', { headers: { Origin: 'https://evil.example' } })).status,
    403,
  );
  assert.equal(app.opened, 0);
  const preflight = await app.call('/api/players', {
    method: 'OPTIONS',
    headers: { Origin: 'https://ibadz.example' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(app.opened, 0);
  assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), 'true');
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /X-Requested-With/);
  const response = await app.call('/api/players', {
    headers: { ...cookie, Origin: 'https://ibadz.example' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://ibadz.example');
  assert.equal(app.closed, 1);
});
test('Worker public health and failures clean up without leaking connection details', async () => {
  const app = setup();
  assert.equal((await app.call('/api/health')).status, 200);
  assert.equal(app.closed, 1);
  const failed = setup({ fail: true });
  const response = await failed.call('/api/health');
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('private-database-details'));
  assert.equal(failed.closed, 1);
});
test('Worker enforces mutation header and input limits for authenticated admins', async () => {
  const app = setup();
  const call = (body, type = 'application/json', headers = {}) =>
    app.call('/api/sessions', {
      method: 'POST',
      headers: { ...cookie, 'Content-Type': type, ...headers },
      body,
    });
  assert.equal((await call('{}', 'application/json', { 'X-Requested-With': '' })).status, 403);
  assert.equal((await call('{}', 'text/plain')).status, 415);
  assert.equal((await call('{')).status, 400);
  assert.equal((await call('{}')).status, 400);
  assert.equal((await call(' '.repeat(256001))).status, 413);
});
