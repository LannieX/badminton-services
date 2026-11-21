import { adminFixture } from './auth-helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, migrate } from '../src/db.mjs';
import { createPlayerService, hashPassword } from '../src/players.mjs';
import { createHandler } from '../src/handler.mjs';

const profile = {
  name: 'นักแบด',
  username: 'TEST.Player',
  avatar: '',
  password: 'strong-password',
};
test('password hashing uses random salts and does not contain plaintext', async () => {
  const a = await hashPassword(profile.password);
  const b = await hashPassword(profile.password);
  assert.notEqual(a, b);
  assert.match(a, /^pbkdf2-sha256\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.ok(!a.includes(profile.password));
});
test('player endpoints validate IDs, inputs, oversized bodies, and do not leak internals', async () => {
  const pool = {
    query(sql) {
      if (sql.startsWith('UPDATE rally_auth_sessions'))
        return { rows: [{ id: randomUUID(), role: 'admin', status: 'active' }] };
      throw new Error('private-connection-string');
    },
  };
  const handle = createHandler({}, pool);
  const call = (path, data, method = 'POST') =>
    handle(
      new Request(`http://localhost/api${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'ibadz',
          Cookie: 'ibadz_session=' + '1'.repeat(64),
        },
        body: JSON.stringify(data),
      }),
    );
  assert.equal((await call('/players', { ...profile, password: 'short' })).status, 400);
  assert.equal((await call('/players/a', profile, 'PUT')).status, 400);
  assert.equal((await call('/players', { ...profile, avatar: 'x'.repeat(257000) })).status, 413);
  const response = await handle(
    new Request('http://localhost/api/players', {
      headers: { Cookie: 'ibadz_session=' + '1'.repeat(64) },
    }),
  );
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes('private-connection-string'));
});
test(
  'Postgres players: CRUD, exact search, unique username, Cloudinary URLs and upload cleanup',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const schema = `players_test_${randomUUID().replaceAll('-', '')}`;
    const admin = createPool(process.env.DATABASE_URL);
    const pool = createPool(process.env.DATABASE_URL, schema);
    const uploads = [];
    const deleted = [];
    const cloud = async (url, options) => {
      const form = options.body;
      assert.ok(form.get('signature'));
      assert.equal(form.get('api_key'), 'test-key');
      if (url.endsWith('/destroy')) {
        deleted.push(form.get('public_id'));
        return Response.json({ result: 'ok' });
      }
      const id = form.get('public_id');
      uploads.push(id);
      return Response.json({
        public_id: id,
        secure_url: `https://res.cloudinary.com/test-cloud/image/upload/v1/${id}.webp`,
      });
    };
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await migrate(pool);
      await migrate(pool);
      const players = createPlayerService(
        pool,
        { CLOUDINARY_URL: 'cloudinary://test-key:test-secret@test-cloud' },
        cloud,
      );
      const image = 'data:image/png;base64,iVBORw0KGgo=';
      const saved = await players.save(null, { ...profile, avatar: image });
      const fixture = await adminFixture(pool);
      const handle = createHandler({}, pool);
      const response = await handle(
        new Request('http://localhost/api/players?q=TEST', { headers: fixture.headers }),
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { players: [saved] });
      const add = await handle(
        new Request('http://localhost/api/players', {
          method: 'POST',
          headers: fixture.headers,
          body: JSON.stringify({ ...profile, username: 'second_player', avatar: '' }),
        }),
      );
      assert.equal(add.status, 201);
      const second = (await add.json()).player;
      assert.ok(!('password_hash' in second));
      const edit = await handle(
        new Request(`http://localhost/api/players/${second.id}`, {
          method: 'PUT',
          headers: fixture.headers,
          body: JSON.stringify({
            name: 'แก้ไขผ่าน API',
            username: 'second_player',
            avatar: '',
          }),
        }),
      );
      assert.equal(edit.status, 200);
      assert.equal((await edit.json()).player.name, 'แก้ไขผ่าน API');
      assert.equal(
        (
          await handle(
            new Request(`http://localhost/api/players/${second.id}`, {
              method: 'DELETE',
              headers: fixture.headers,
            }),
          )
        ).status,
        405,
      );
      await players.delete(second.id);
      assert.equal((await players.listPage()).pageSize, 10);
      const pageOne = await players.listPage('', 1, 1);
      assert.equal(pageOne.total, 2);
      assert.equal(pageOne.players.length, 1);
      const pageTwo = await players.listPage('', 2, 1);
      assert.notEqual(pageOne.players[0].id, pageTwo.players[0].id);
      assert.equal((await players.listPage('', 999, 1)).page, 2);
      assert.equal((await players.listPage('no.match', 3, 12)).page, 1);
      assert.equal((await players.listPage('test.player', 1, 12)).total, 1);
      await assert.rejects(players.listPage('', -1, 12), (error) => error.status === 400);
      await assert.rejects(
        players.save(null, { ...profile, username: 'eight_chars', password: '1234567' }),
        (error) => error.status === 400 && error.message.includes('8'),
      );
      const eight = await players.save(null, {
        ...profile,
        username: 'eight_chars',
        password: '12345678',
      });
      await players.delete(eight.id);
      assert.equal(saved.username, 'test.player');
      assert.match(saved.avatar, /^https:\/\/res.cloudinary.com/);
      assert.ok(!('password_hash' in saved));
      assert.ok(!('password' in saved));
      const row = (await pool.query('SELECT * FROM rally_players WHERE id=$1', [saved.id])).rows[0];
      assert.equal(row.avatar_url, saved.avatar);
      assert.ok(!row.avatar_url.startsWith('data:'));
      assert.match(row.password_hash, /^pbkdf2-sha256/);
      assert.equal(uploads.length, 1);
      await assert.rejects(
        players.save(null, { ...profile, username: 'TEST.PLAYER' }),
        (e) => e.status === 409,
      );
      assert.equal((await players.list('นักแบด')).length, 1);
      assert.equal((await players.list('%')).length, 0);
      assert.equal(saved.role, 'viewer');
      await pool.query('UPDATE rally_players SET role_id=1 WHERE id=$1', [saved.id]);
      const updated = await players.save(saved.id, {
        name: 'ชื่อใหม่',
        username: saved.username,
        avatar: saved.avatar,
      });
      assert.equal(updated.name, 'ชื่อใหม่');
      assert.equal(updated.role, 'admin');
      await assert.rejects(
        players.save(null, { ...profile, username: 'role_injection', role: 'admin' }),
        (e) => e.status === 400,
      );
      assert.deepEqual(
        (await pool.query('SELECT name FROM rally_roles ORDER BY id')).rows.map((r) => r.name),
        ['admin', 'viewer'],
      );
      await assert.rejects(
        pool.query('UPDATE rally_players SET role_id=999 WHERE id=$1', [saved.id]),
        (e) => e.code === '23503',
      );
      assert.equal(uploads.length, 1);
      assert.equal(
        (await pool.query('SELECT password_hash FROM rally_players WHERE id=$1', [saved.id]))
          .rows[0].password_hash,
        row.password_hash,
      );
      await assert.rejects(
        players.save(saved.id, { ...profile, avatar: 'https://evil.example/image.png' }),
        (e) => e.status === 400,
      );
      await players.save(saved.id, { ...profile, avatar: image });
      assert.equal(uploads.length, 2);
      assert.deepEqual(deleted, [uploads[0]]);
      await pool.query(
        `CREATE FUNCTION reject_player_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test reject'; END; $$`,
      );
      await pool.query(
        `CREATE TRIGGER reject_update BEFORE UPDATE ON rally_players FOR EACH ROW EXECUTE FUNCTION reject_player_update()`,
      );
      await assert.rejects(players.save(saved.id, { ...profile, avatar: image }));
      assert.equal(uploads.length, 3);
      assert.ok(deleted.includes(uploads[2]));
      await pool.query('DROP TRIGGER reject_update ON rally_players');
      // Removing the draft picture must not touch storage before save.
      assert.ok(!deleted.includes(uploads[1]));
      const cleared = await players.save(saved.id, { ...profile, avatar: '' });
      assert.equal(cleared.avatar, '');
      assert.ok(deleted.includes(uploads[1]));
      const clearedRow = (
        await pool.query('SELECT avatar_url,avatar_public_id FROM rally_players WHERE id=$1', [
          saved.id,
        ])
      ).rows[0];
      assert.equal(clearedRow.avatar_url, '');
      assert.equal(clearedRow.avatar_public_id, null);
      const destroyCount = deleted.length;
      await players.delete(saved.id);
      assert.equal(deleted.length, destroyCount);
      assert.equal((await players.list('test.player')).length, 0);
      await assert.rejects(players.delete(saved.id), (e) => e.status === 404);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  'role migration preserves existing admins, users, passwords and avatar URLs and is repeatable',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const schema = `roles_test_${randomUUID().replaceAll('-', '')}`;
    const admin = createPool(process.env.DATABASE_URL);
    const pool = createPool(process.env.DATABASE_URL, schema);
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await migrate(pool);
      await pool.query('ALTER TABLE rally_players DROP COLUMN role_id');
      const adminId = randomUUID();
      const userId = randomUUID();
      await pool.query(
        `INSERT INTO rally_players(id,name,username,role,password_hash,avatar_url) VALUES ($1,'Admin','legacy_admin','admin','existing-hash','https://res.cloudinary.com/test/image/upload/test.png'),($2,'User','legacy_user','player',NULL,'')`,
        [adminId, userId],
      );
      await migrate(pool);
      await migrate(pool);
      const rows = (
        await pool.query(
          'SELECT p.id,r.name AS role,p.password_hash,p.avatar_url FROM rally_players p JOIN rally_roles r ON r.id=p.role_id ORDER BY p.username',
        )
      ).rows;
      assert.equal(rows[0].role, 'admin');
      assert.equal(rows[1].role, 'viewer');
      assert.equal(rows[0].password_hash, 'existing-hash');
      assert.equal(rows[0].avatar_url, 'https://res.cloudinary.com/test/image/upload/test.png');
      await pool.query('UPDATE rally_players SET role_id=1 WHERE id=$1', [userId]);
      await migrate(pool);
      assert.equal(
        (await pool.query('SELECT role_id FROM rally_players WHERE id=$1', [userId])).rows[0]
          .role_id,
        1,
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
