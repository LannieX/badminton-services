import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, migrate } from '../src/db.mjs';
import { createRepository } from '../src/repository.mjs';
import { createApp } from '../src/app.mjs';
import { sessionInput, matchInput, updateInput, paymentInput } from '../src/validation.mjs';
test('rejects invalid values and whitespace', () => {
  for (const code of ['022', '024', '069', '071', '073', '052', '035', '098', '080', '023'])
    assert.equal(
      paymentInput.safeParse({
        id: randomUUID(),
        totalCents: 10000,
        playerCount: 2,
        method: 'bank',
        recipient: '1234567890',
        bankCode: code,
      }).success,
      true,
    );
  assert.equal(
    sessionInput.safeParse({ id: randomUUID(), name: ' ', date: '2026-11-07' }).success,
    false,
  );
  assert.equal(
    sessionInput.safeParse({ id: randomUUID(), name: 'ก๊วน', date: '2026-02-30' }).success,
    false,
  );
  assert.equal(
    updateInput.safeParse({
      version: 1,
      expenses: [{ id: randomUUID(), title: 'สนาม', amount: 1.001 }],
      members: [],
    }).success,
    false,
  );
  assert.equal(
    matchInput.safeParse({
      id: randomUUID(),
      time: new Date().toISOString(),
      mode: 'double',
      names: ['A', 'B'],
      scores: [9, 9],
      target: 10,
    }).success,
    false,
  );
});
test(
  'PostgreSQL API: sessions, expenses, payment resets, conflicts, idempotent and concurrent finishes',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const schema = `rally_test_${randomUUID().replaceAll('-', '')}`;
    const admin = createPool(process.env.DATABASE_URL);
    const pool = createPool(process.env.DATABASE_URL, schema);
    let server;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await migrate(pool);
      server = createApp(createRepository(pool), pool);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${server.address().port}/api`;
      const call = async (path, method = 'GET', body) => {
        const r = await fetch(base + path, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        return { status: r.status, data: await r.json() };
      };
      assert.equal((await call('/health')).status, 200);
      assert.deepEqual((await call('/sessions')).data.sessions, []);
      assert.equal(
        (await call('/sessions', 'POST', { id: randomUUID(), name: ' ', date: '2026-11-07' }))
          .status,
        400,
      );
      const id = randomUUID();
      const create = { id, name: 'ทดสอบระบบ', date: '2026-11-07' };
      let session = (await call('/sessions', 'POST', create)).data.session;
      assert.equal(session.version, 1);
      const member = { id: randomUUID(), name: 'คนทดสอบ', paid: true };
      const expense = { id: randomUUID(), title: 'สนามทดสอบ', amount: 123.45 };
      session = (
        await call(`/sessions/${id}`, 'PUT', {
          version: session.version,
          members: [member],
          expenses: [expense],
        })
      ).data.session;
      assert.equal(session.members[0].paid, false);
      assert.equal(session.expenses[0].amount, 123.45);
      assert.equal(
        (await call(`/sessions/${id}`, 'PUT', { version: 1, members: [], expenses: [] })).status,
        409,
      );
      session = (
        await call(`/sessions/${id}`, 'PUT', {
          version: session.version,
          members: [member],
          expenses: [expense],
        })
      ).data.session;
      assert.equal(session.members[0].paid, true);
      session = (
        await call(`/sessions/${id}`, 'PUT', {
          version: session.version,
          members: [member],
          expenses: [{ ...expense, amount: 200 }],
        })
      ).data.session;
      assert.equal(session.members[0].paid, false);
      session = (
        await call(`/sessions/${id}`, 'PUT', {
          version: session.version,
          members: [],
          expenses: [],
        })
      ).data.session;
      assert.equal(session.members.length, 0);
      assert.equal(session.expenses.length, 0);
      const match = {
        id: randomUUID(),
        time: new Date().toISOString(),
        mode: 'double',
        names: ['ทดสอบ A', 'ทดสอบ B'],
        scores: [10, 4],
        target: 10,
      };
      const repeated = await Promise.all(
        Array.from({ length: 3 }, () => call('/matches', 'POST', match)),
      );
      assert.ok(repeated.every((r) => r.status === 200));
      const saved = repeated[0].data.session;
      assert.equal(saved.matches.length, 1);
      const parallel = await Promise.all([
        call('/matches', 'POST', { ...match, id: randomUUID() }),
        call('/matches', 'POST', { ...match, id: randomUUID() }),
      ]);
      assert.ok(parallel.every((r) => r.status === 200));
      const list = (await call('/sessions')).data.sessions;
      const daily = list.find((s) => s.id === saved.id);
      assert.equal(daily.matches.length, 3);
      assert.equal(list.length, 2);
      const legacy = {
        id: randomUUID(),
        name: 'นำเข้าทดสอบ',
        date: '2020-01-01',
        members: [],
        expenses: [{ id: randomUUID(), title: 'สนามเดิม', amount: 100 }],
        matches: [{ ...match, id: randomUUID(), time: '2020-01-01T12:00:00.000Z' }],
      };
      assert.equal((await call('/import', 'POST', { sessions: [legacy] })).status, 200);
      assert.equal((await call('/import', 'POST', { sessions: [legacy] })).status, 200);
      const imported = (await call('/sessions')).data.sessions.find((s) => s.id === legacy.id);
      assert.equal(imported.matches.length, 1);
      assert.equal(imported.expenses.length, 1);
      const payment = {
        id: randomUUID(),
        sessionId: id,
        totalCents: 10000,
        playerCount: 3,
        method: 'promptpay',
        recipient: '0812345678',
      };
      assert.equal(
        (await call('/payment-requests', 'POST', { ...payment, playerCount: 0 })).status,
        400,
      );
      assert.equal(
        (await call('/payment-requests', 'POST', { ...payment, recipient: '123' })).status,
        400,
      );
      assert.equal(
        (await call('/payment-requests', 'POST', { ...payment, totalCents: 1 })).status,
        400,
      );
      assert.equal(
        (await call('/payment-requests', 'POST', { ...payment, totalCents: 1.5 })).status,
        400,
      );
      const bill = await call('/payment-requests', 'POST', payment);
      assert.equal(bill.status, 200);
      assert.equal(bill.data.session.paymentRequests.length, 1);
      assert.equal(
        (await call('/payment-requests', 'POST', payment)).data.session.paymentRequests.length,
        1,
      );
      assert.equal(
        (await call('/payment-requests', 'POST', { ...payment, totalCents: 20000 })).status,
        409,
      );
      const bankPayment = {
        ...payment,
        id: randomUUID(),
        method: 'bank',
        recipient: '1234567890',
        bankCode: '014',
      };
      assert.equal(
        (await call('/payment-requests', 'POST', { ...bankPayment, bankCode: '999' })).status,
        400,
      );
      assert.equal((await call('/payment-requests', 'POST', bankPayment)).status, 200);
      const requests = (await call('/sessions')).data.sessions.find(
        (s) => s.id === id,
      ).paymentRequests;
      assert.equal(requests.length, 2);
      assert.equal(
        requests.reduce((sum, p) => sum + p.totalCents, 0),
        20000,
      );
      assert.equal(
        (
          await call('/payment-requests', 'POST', {
            ...payment,
            id: randomUUID(),
            sessionId: undefined,
          })
        ).status,
        200,
      );

      const before = (await call('/sessions')).data.sessions.find((s) => s.id === id);
      const endpoint = '/sessions/' + id + '/payment-requests/' + payment.id;
      const revised = { ...payment, totalCents: 15000, playerCount: 5 };
      assert.equal(
        (
          await call(endpoint, 'PUT', {
            version: before.version,
            payment: { ...revised, playerCount: 0 },
          })
        ).status,
        400,
      );
      const edited = await call(endpoint, 'PUT', { version: before.version, payment: revised });
      assert.equal(edited.status, 200);
      assert.equal(
        edited.data.session.paymentRequests.find((p) => p.id === payment.id).totalCents,
        15000,
      );
      assert.equal(
        edited.data.session.paymentRequests.find((p) => p.id === payment.id).playerCount,
        5,
      );
      assert.equal(
        (
          await call(endpoint, 'PUT', {
            version: before.version,
            payment: { ...revised, totalCents: 20000 },
          })
        ).status,
        409,
      );
      assert.equal(
        (await call(endpoint, 'PUT', { version: before.version, payment: revised })).status,
        200,
      );
      assert.equal(
        (
          await call('/sessions/' + legacy.id + '/payment-requests/' + payment.id, 'DELETE', {
            version: 1,
          })
        ).status,
        404,
      );
      assert.equal((await call(endpoint, 'DELETE', { version: before.version })).status, 409);
      const removed = await call(endpoint, 'DELETE', { version: edited.data.session.version });
      assert.equal(removed.status, 200);
      assert.equal(removed.data.session.paymentRequests.length, 1);
      assert.equal(removed.data.session.paymentRequests[0].id, bankPayment.id);
      assert.equal(
        (await call(endpoint, 'DELETE', { version: edited.data.session.version })).status,
        200,
      );
      assert.equal(
        (await call(endpoint, 'PUT', { version: removed.data.session.version, payment: revised }))
          .status,
        404,
      );
      assert.equal((await call('/payment-requests', 'POST', payment)).status, 409);
      assert.equal(
        (await call('/sessions')).data.sessions.find((s) => s.id === id).paymentRequests.length,
        1,
      );
      assert.equal((await call('/matches', 'POST', { ...match, scores: [10, 5] })).status, 409);
      assert.equal(
        (await call('/matches', 'POST', { ...match, id: randomUUID(), scores: [1, 0] })).status,
        400,
      );
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
