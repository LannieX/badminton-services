import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../src/worker.mjs';

const environment = {
  DATABASE_URL: 'postgresql://test:unused@invalid/test',
  API_TOKEN: 'test-api-access-only',
  ALLOWED_ORIGINS: 'http://localhost:5173,https://ibadz.example',
};
function setup({ fail = false } = {}) {
  let queries = 0;
  let closed = 0;
  const pending = [];
  const worker = createWorker(() => ({
    on() {},
    async query() {
      queries++;
      if (fail) throw new Error('private-database-details');
      return { rows: [] };
    },
    async end() {
      closed++;
    },
  }));
  return {
    async request(path, { headers, ...options } = {}, env = environment) {
      const response = await worker.fetch(
        new Request(`https://api.example${path}`, {
          ...options,
          headers: { Authorization: `Bearer ${environment.API_TOKEN}`, ...headers },
        }),
        env,
        { waitUntil: (promise) => pending.push(promise) },
      );
      await Promise.all(pending);
      return response;
    },
    get queries() {
      return queries;
    },
    get closed() {
      return closed;
    },
  };
}

test('Worker protects session and payment endpoints before opening a database connection', async () => {
  const app = setup();
  for (const path of ['/api/sessions', '/api/payment-requests', '/api/import']) {
    assert.equal((await app.request(path, { headers: { Authorization: '' } })).status, 401);
    assert.equal(
      (await app.request(path, { headers: { Authorization: 'Bearer wrong' } })).status,
      401,
    );
  }
  assert.equal(
    (await app.request('/api/sessions', {}, { ...environment, API_TOKEN: '' })).status,
    503,
  );
  assert.equal(app.queries, 0);
});

test('Worker allows only configured cross-origin clients and handles preflight', async () => {
  const app = setup();
  const rejected = await app.request('/api/sessions', {
    headers: { Origin: 'https://unapproved.example' },
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.has('Access-Control-Allow-Origin'), false);
  assert.equal(app.queries, 0);
  const preflight = await app.request('/api/sessions', {
    method: 'OPTIONS',
    headers: { Origin: 'https://ibadz.example', Authorization: '' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://ibadz.example');
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  assert.equal(app.queries, 0);
  const sessions = await app.request('/api/sessions', {
    headers: { Origin: 'http://localhost:5173' },
  });
  assert.equal(sessions.status, 200);
  assert.deepEqual(await sessions.json(), { sessions: [] });
  assert.equal(sessions.headers.get('Vary'), 'Origin');
  assert.equal(app.closed, 1);
});

test('Worker exposes a read-only database health check and cleans up connections on failure', async () => {
  const app = setup();
  const health = await app.request('/api/health', { headers: { Authorization: '' } });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', database: 'connected' });
  assert.equal(app.closed, 1);
  const failing = setup({ fail: true });
  const response = await failing.request('/api/health');
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /private-database-details/);
  assert.equal(failing.closed, 1);
});

test('Worker preserves API validation and bounded streaming JSON bodies', async () => {
  const app = setup();
  const send = (body, contentType = 'application/json') =>
    app.request('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
    });
  assert.equal((await send('{}', 'text/plain')).status, 415);
  assert.equal((await send('{')).status, 400);
  assert.equal((await send('{}')).status, 400);
  assert.equal((await send(' '.repeat(256001))).status, 413);
  assert.equal((await app.request('/api/not-found')).status, 404);
  assert.equal(app.queries, 0);
  assert.equal(app.closed, 5);
});
