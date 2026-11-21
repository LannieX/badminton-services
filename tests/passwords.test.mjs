import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, migrate } from '../src/db.mjs';
import { createHandler } from '../src/handler.mjs';
import { createRepository } from '../src/repository.mjs';
import { createPlayerService } from '../src/players.mjs';
import { createAuth } from '../src/auth.mjs';
import { adminFixture } from './auth-helper.mjs';
test(
  'password reset enforces viewer self-only, admin targets, confirmation and session revocation',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const schema = 'password_test_' + randomUUID().replaceAll('-', ''),
      admin = createPool(process.env.DATABASE_URL),
      pool = createPool(process.env.DATABASE_URL, schema);
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await migrate(pool);
      const fixture = await adminFixture(pool),
        players = createPlayerService(pool),
        auth = createAuth(pool),
        handle = createHandler(createRepository(pool), pool);
      const viewer = await players.save(null, {
        name: 'Viewer',
        username: 'reset.viewer',
        password: 'old-pass-123',
        avatar: '',
      });
      const login = await auth.login({ username: viewer.username, password: 'old-pass-123' }),
        other = await auth.login({ username: viewer.username, password: 'old-pass-123' });
      const cookie = 'ibadz_session=' + login.token,
        otherCookie = 'ibadz_session=' + other.token;
      const call = async (path, method = 'GET', body, c = fixture.headers.Cookie) =>
        handle(
          new Request('https://app.example/api' + path, {
            method,
            headers: {
              'Content-Type': 'application/json',
              'X-Requested-With': 'ibadz',
              ...(c ? { Cookie: c } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      const input = {
        username: viewer.username,
        password: 'new-pass-123',
        confirmPassword: 'new-pass-123',
      };
      assert.equal((await call('/auth/reset-password', 'POST', input, '')).status, 401);
      assert.equal(
        (
          await call(
            '/auth/reset-password',
            'POST',
            { ...input, username: fixture.player.username },
            cookie,
          )
        ).status,
        403,
      );
      assert.equal(
        (await call('/auth/reset-password', 'POST', { ...input, password: '1234567' }, cookie))
          .status,
        400,
      );
      assert.equal(
        (
          await call(
            '/auth/reset-password',
            'POST',
            { ...input, confirmPassword: 'wrong-pass' },
            cookie,
          )
        ).status,
        400,
      );
      assert.equal(
        (await call('/auth/reset-password', 'POST', { ...input, role: 'admin' }, cookie)).status,
        400,
      );
      assert.equal((await call('/auth/reset-password', 'POST', input, cookie)).status, 200);
      assert.equal((await call('/auth/me', 'GET', undefined, cookie)).status, 200);
      assert.equal((await call('/auth/me', 'GET', undefined, otherCookie)).status, 401);
      await assert.rejects(
        auth.login({ username: viewer.username, password: 'old-pass-123' }),
        (error) => error.status === 401,
      );
      assert.equal(
        (await auth.login({ username: viewer.username, password: input.password })).user.role,
        'viewer',
      );
      assert.equal(
        (
          await call('/auth/reset-password', 'POST', {
            ...input,
            password: 'admin-pass-123',
            confirmPassword: 'admin-pass-123',
          })
        ).status,
        200,
      );
      assert.equal((await call('/auth/me', 'GET', undefined, cookie)).status, 401);
      assert.equal((await call('/auth/me')).status, 200);
      assert.equal(
        (await auth.login({ username: viewer.username, password: 'admin-pass-123' })).user.id,
        viewer.id,
      );
      assert.equal(
        (await call('/auth/reset-password', 'POST', { ...input, username: 'missing.member' }))
          .status,
        404,
      );
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
      await admin.end();
    }
  },
);
