import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, migrate } from '../src/db.mjs';
import { createHandler } from '../src/handler.mjs';
import { createRepository } from '../src/repository.mjs';
import { createPlayerService } from '../src/players.mjs';
import { digest, verifyPassword } from '../src/auth.mjs';
import { adminFixture } from './auth-helper.mjs';

test(
  'login, admin/viewer permissions, inactive revocation, per-member payments and logout',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const schema = `auth_test_${randomUUID().replaceAll('-', '')}`;
    const admin = createPool(process.env.DATABASE_URL),
      pool = createPool(process.env.DATABASE_URL, schema);
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await migrate(pool);
      await migrate(pool);
      const fixture = await adminFixture(pool);
      const handle = createHandler(createRepository(pool), pool);
      const call = async (
        path,
        method = 'GET',
        body,
        cookie = fixture.headers.Cookie,
        extra = {},
      ) => {
        const response = await handle(
          new Request('https://app.example/api' + path, {
            method,
            headers: {
              'Content-Type': 'application/json',
              'X-Requested-With': 'ibadz',
              ...(cookie ? { Cookie: cookie } : {}),
              ...extra,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
        return {
          status: response.status,
          data: await response.json(),
          cookie: response.headers.get('Set-Cookie'),
        };
      };
      const adminInput = {
        name: fixture.player.name,
        username: fixture.player.username,
        avatar: '',
        status: 'inactive',
      };
      assert.equal(
        (await call(`/players/${fixture.player.id}`, 'PUT', adminInput)).status,
        400,
        'admin cannot deactivate own account',
      );
      await assert.rejects(
        createPlayerService(pool).save(fixture.player.id, adminInput),
        (error) => error.status === 400,
        'last admin must stay active',
      );
      assert.equal((await call('/players', 'GET', undefined, '')).status, 401);
      assert.equal(
        (await call('/players', 'POST', {}, fixture.headers.Cookie, { 'X-Requested-With': '' }))
          .status,
        403,
      );
      const input = {
        name: 'Viewer member',
        username: 'new.viewer',
        avatar: '',
        password: 'viewer-secret',
      };
      let result = await call('/players', 'POST', input);
      assert.equal(result.status, 201);
      const viewer = result.data.player;
      assert.equal(viewer.role, 'viewer');
      assert.equal(viewer.status, 'active');
      assert.ok(!JSON.stringify(result.data).includes('password'));
      const stored = (
        await pool.query('SELECT password_hash FROM rally_players WHERE id=$1', [viewer.id])
      ).rows[0];
      assert.ok(await verifyPassword(input.password, stored.password_hash));
      assert.ok(!(await verifyPassword('incorrect', stored.password_hash)));
      assert.equal(
        (await call('/auth/login', 'POST', { username: input.username, password: 'wrong' }, ''))
          .status,
        401,
      );
      result = await call(
        '/auth/login',
        'POST',
        { username: 'NEW.VIEWER', password: input.password },
        '',
      );
      assert.equal(result.status, 200);
      assert.match(result.cookie, /HttpOnly/);
      assert.match(result.cookie, /Secure/);
      assert.match(result.cookie, /SameSite=Strict/);
      assert.match(result.cookie, /Max-Age=1296000/);
      const lifetime = (
        await pool.query(
          'SELECT EXTRACT(EPOCH FROM (expires_at-created_at))::integer AS seconds FROM rally_auth_sessions WHERE token_hash=$1',
          [await digest(result.cookie.split(';')[0].split('=')[1])],
        )
      ).rows[0].seconds;
      assert.equal(lifetime, 1296000);
      const sessionHash = await digest(result.cookie.split(';')[0].split('=')[1]);
      await pool.query(
        "UPDATE rally_auth_sessions SET expires_at=created_at+interval '7 days' WHERE token_hash=$1",
        [sessionHash],
      );
      await migrate(pool);
      assert.equal(
        (
          await pool.query(
            'SELECT EXTRACT(EPOCH FROM (expires_at-created_at))::integer AS seconds FROM rally_auth_sessions WHERE token_hash=$1',
            [sessionHash],
          )
        ).rows[0].seconds,
        1296000,
        'valid older sessions are extended without logging in again',
      );

      let viewerCookie = result.cookie.split(';')[0];
      assert.equal(
        (await call('/auth/me', 'GET', undefined, viewerCookie)).data.user.role,
        'viewer',
      );
      const guestInput = { id: randomUUID(), name: 'Guest badminton player' };
      assert.equal((await call('/guests', 'POST', guestInput, '')).status, 401);
      const guest = await call('/guests', 'POST', guestInput, viewerCookie);
      assert.equal(guest.status, 201);
      assert.equal(guest.data.player.kind, 'guest');
      assert.equal(guest.data.player.username, '');
      assert.equal((await call('/guests', 'POST', guestInput, viewerCookie)).status, 201);
      assert.equal(
        (await call('/guests', 'POST', { ...guestInput, role: 'admin' }, viewerCookie)).status,
        400,
      );
      const guestRecord = (
        await pool.query('SELECT username,password_hash FROM rally_players WHERE id=$1', [
          guestInput.id,
        ])
      ).rows[0];
      assert.equal(guestRecord.password_hash, null);
      assert.equal(
        (
          await call(
            '/auth/login',
            'POST',
            { username: guestRecord.username, password: 'anything' },
            '',
          )
        ).status,
        401,
      );
      assert.ok((await createPlayerService(pool).list('')).some((p) => p.id === guestInput.id));
      assert.ok(
        !(await createPlayerService(pool).listPage('', 1)).players.some(
          (p) => p.id === guestInput.id,
        ),
      );
      const ownPayment = {
        id: randomUUID(),
        totalCents: 101,
        playerCount: 2,
        memberIds: [viewer.id, guestInput.id],
        method: 'promptpay',
        recipient: '0812345678',
      };
      let own = await call('/payment-requests', 'POST', ownPayment, viewerCookie);
      assert.equal(own.status, 200);
      let ownSession = own.data.session;
      let ownBill = ownSession.paymentRequests.find((p) => p.id === ownPayment.id);
      assert.equal(ownBill.createdBy, viewer.id);
      assert.equal(ownBill.members[1].kind, 'guest');
      assert.deepEqual(
        ownBill.members.map((m) => m.amountCents),
        [51, 50],
      );
      const stranger = (await call('/players', 'POST', { ...input, username: 'stranger.viewer' }))
        .data.player;
      const strangerLogin = await call(
        '/auth/login',
        'POST',
        { username: stranger.username, password: input.password },
        '',
      );
      const strangerCookie = strangerLogin.cookie.split(';')[0];
      const ownPath = `/sessions/${ownSession.id}/payment-requests/${ownPayment.id}`;
      assert.equal(
        (await call(ownPath, 'DELETE', { version: ownSession.version }, strangerCookie)).status,
        403,
      );
      const confirmationPath = `/payment-requests/${ownPayment.id}/members/${guestInput.id}`;
      assert.equal(
        (
          await call(
            confirmationPath,
            'PATCH',
            { paid: true, version: ownSession.version },
            strangerCookie,
          )
        ).status,
        403,
      );
      own = await call(
        confirmationPath,
        'PATCH',
        { paid: true, version: ownSession.version },
        viewerCookie,
      );
      assert.equal(own.status, 200);
      ownSession = own.data.session;
      own = await call(
        ownPath,
        'PUT',
        { version: ownSession.version, payment: { ...ownPayment, recipient: '0899999999' } },
        viewerCookie,
      );
      assert.equal(own.status, 200);
      assert.equal(
        (await call(ownPath, 'DELETE', { version: own.data.session.version }, viewerCookie)).status,
        200,
      );
      const ordinaryMatch = {
        id: randomUUID(),
        time: new Date().toISOString(),
        mode: 'double',
        names: ['Viewer home', 'Viewer away'],
        scores: [16, 12],
        target: 16,
      };
      assert.equal((await call('/matches', 'POST', ordinaryMatch, '')).status, 401);
      assert.equal((await call('/matches', 'POST', {}, viewerCookie)).status, 400);
      const viewerResult = await call('/matches', 'POST', ordinaryMatch, viewerCookie);
      assert.equal(viewerResult.status, 200);
      assert.ok(viewerResult.data.session.matches.some((match) => match.id === ordinaryMatch.id));
      const retryResult = await call('/matches', 'POST', ordinaryMatch, viewerCookie);
      assert.equal(retryResult.status, 200);
      assert.equal(
        retryResult.data.session.matches.filter((match) => match.id === ordinaryMatch.id).length,
        1,
      );
      const selfInput = { name: 'My new name', username: 'renamed.viewer', avatar: '' };
      const self = await call('/auth/me', 'PUT', selfInput, viewerCookie);
      assert.equal(self.status, 200);
      assert.equal(self.data.user.id, viewer.id);
      assert.equal(self.data.user.username, selfInput.username);
      assert.equal(self.data.user.role, 'viewer');
      assert.equal(self.data.user.status, 'active');
      assert.equal(
        (await call('/auth/me', 'GET', undefined, viewerCookie)).data.user.name,
        selfInput.name,
      );
      assert.equal(
        (await pool.query('SELECT password_hash FROM rally_players WHERE id=$1', [viewer.id]))
          .rows[0].password_hash,
        stored.password_hash,
      );
      assert.equal(
        (
          await call(
            '/auth/login',
            'POST',
            { username: selfInput.username, password: input.password },
            '',
          )
        ).status,
        200,
      );
      for (const forbidden of [
        { id: fixture.player.id },
        { role: 'admin' },
        { status: 'inactive' },
        { password: 'unauthorized-change' },
      ])
        assert.equal(
          (await call('/auth/me', 'PUT', { ...selfInput, ...forbidden }, viewerCookie)).status,
          400,
        );
      assert.equal(
        (
          await call(
            '/auth/me',
            'PUT',
            { ...selfInput, username: fixture.player.username },
            viewerCookie,
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await call(
            '/auth/me',
            'PUT',
            { name: input.name, username: input.username, avatar: '' },
            viewerCookie,
          )
        ).status,
        200,
      );
      await pool.query(
        "UPDATE rally_auth_sessions SET last_seen_at=now()-interval '2 days' WHERE token_hash=$1",
        [await digest(viewerCookie.split('=')[1])],
      );
      const idle = await call('/auth/me', 'GET', undefined, viewerCookie);
      assert.equal(idle.status, 200, 'two days idle must not expire a 15-day session');
      assert.ok(!('_sessionExpiresAt' in idle.data.user));
      assert.match(idle.cookie, /Max-Age=1295\d+/);
      assert.equal((await call('/players', 'GET', undefined, viewerCookie)).status, 200);
      assert.equal((await call('/sessions', 'GET', undefined, viewerCookie)).status, 200);
      for (const [path, method, body] of [
        ['/players', 'POST', input],
        [`/players/${viewer.id}`, 'PUT', input],
        [`/players/${viewer.id}`, 'DELETE', {}],
        ['/sessions', 'POST', {}],
        ['/import', 'POST', {}],
      ])
        assert.equal((await call(path, method, body, viewerCookie)).status, 403);
      assert.equal(
        (await call('/players', 'POST', { ...input, username: 'escalate', role: 'admin' })).status,
        400,
      );
      assert.equal((await call(`/players/${viewer.id}`, 'DELETE', {})).status, 405);
      let updated = await call(`/players/${viewer.id}`, 'PUT', { ...input, status: 'inactive' });
      assert.equal(updated.status, 200);
      assert.equal((await call('/auth/me', 'GET', undefined, viewerCookie)).status, 401);
      assert.equal(
        (
          await call(
            '/auth/login',
            'POST',
            { username: input.username, password: input.password },
            '',
          )
        ).status,
        401,
      );
      await call(`/players/${viewer.id}`, 'PUT', { ...input, status: 'active' });
      assert.equal(
        (await call('/auth/me', 'GET', undefined, viewerCookie)).status,
        401,
        'reactivation must not restore a revoked session',
      );
      result = await call(
        '/auth/login',
        'POST',
        { username: input.username, password: input.password },
        '',
      );
      viewerCookie = result.cookie.split(';')[0];
      const second = (await call('/players', 'POST', { ...input, username: 'second.viewer' })).data
        .player;
      const payment = {
        id: randomUUID(),
        totalCents: 101,
        playerCount: 2,
        memberIds: [viewer.id, second.id],
        method: 'promptpay',
        recipient: '0812345678',
      };
      result = await call('/payment-requests', 'POST', payment);
      assert.equal(result.status, 200);
      let session = result.data.session;
      let bill = session.paymentRequests.find((p) => p.id === payment.id);
      assert.deepEqual(
        bill.members.map((m) => m.amountCents),
        [51, 50],
      );
      assert.ok(bill.members.every((m) => !m.paidAt));
      const paidPath = `/payment-requests/${payment.id}/members/${viewer.id}`;
      assert.equal(
        (await call(paidPath, 'PATCH', { paid: true, version: session.version }, viewerCookie))
          .status,
        403,
      );
      result = await call(paidPath, 'PATCH', { paid: true, version: session.version });
      assert.equal(result.status, 200);
      session = result.data.session;
      assert.ok(session.paymentRequests[0].members[0].paidAt);
      assert.equal(
        (await call(paidPath, 'PATCH', { paid: false, version: session.version - 1 })).status,
        409,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT confirmed_by FROM rally_payment_members WHERE payment_id=$1 AND player_id=$2',
            [payment.id, viewer.id],
          )
        ).rows[0].confirmed_by,
        fixture.player.id,
      );
      // Recipient-only edits keep confirmations; changed allocation resets them.
      result = await call(`/sessions/${session.id}/payment-requests/${payment.id}`, 'PUT', {
        version: session.version,
        payment: { ...payment, recipient: '0899999999' },
      });
      session = result.data.session;
      assert.ok(session.paymentRequests[0].members[0].paidAt);
      result = await call(`/sessions/${session.id}/payment-requests/${payment.id}`, 'PUT', {
        version: session.version,
        payment: { ...payment, totalCents: 200 },
      });
      session = result.data.session;
      assert.ok(session.paymentRequests[0].members.every((m) => !m.paidAt));
      await call(`/players/${second.id}`, 'PUT', {
        ...input,
        username: 'second.viewer',
        status: 'inactive',
      });
      assert.equal(
        (await call('/payment-requests', 'POST', { ...payment, id: randomUUID() })).status,
        400,
        'new bills cannot add inactive members',
      );
      result = await call('/sessions', 'GET', undefined, viewerCookie);
      assert.equal(result.status, 200);
      assert.equal(
        result.data.sessions[0].paymentRequests[0].members.length,
        2,
        'billing history survives inactive',
      );
      result = await call('/auth/logout', 'POST', {}, viewerCookie);
      assert.equal(result.status, 200);
      assert.match(result.cookie, /Max-Age=0/);
      assert.equal((await call('/auth/me', 'GET', undefined, viewerCookie)).status, 401);
      result = await call(
        '/auth/login',
        'POST',
        { username: input.username, password: input.password },
        '',
      );
      viewerCookie = result.cookie.split(';')[0];
      await pool.query(
        "UPDATE rally_auth_sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=$1",
        [await digest(viewerCookie.split('=')[1])],
      );
      assert.equal((await call('/auth/me', 'GET', undefined, viewerCookie)).status, 401);
      result = await call(
        '/auth/login',
        'POST',
        { username: input.username, password: input.password },
        '',
      );
      viewerCookie = result.cookie.split(';')[0];
      await call(`/players/${viewer.id}`, 'PUT', { ...input, password: 'changed-password' });
      assert.equal(
        (await call('/auth/me', 'GET', undefined, viewerCookie)).status,
        401,
        'password change revokes old sessions',
      );
      for (let i = 0; i < 10; i++)
        assert.equal(
          (await call('/auth/login', 'POST', { username: 'does.not.exist', password: 'wrong' }, ''))
            .status,
          401,
        );
      assert.equal(
        (await call('/auth/login', 'POST', { username: 'does.not.exist', password: 'wrong' }, ''))
          .status,
        429,
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
