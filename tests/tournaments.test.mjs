import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { roundRobin, createTournamentService } from '../src/tournaments.mjs';
import { createPlayerService } from '../src/players.mjs';
import { createPool, migrate } from '../src/db.mjs';
import { createHandler } from '../src/handler.mjs';
import { createRepository } from '../src/repository.mjs';
import { createAuth } from '../src/auth.mjs';
import { adminFixture } from './auth-helper.mjs';

test('round robin gives every team exactly n-1 games, no duplicate opponents, no double booking', () => {
  for (let n = 2; n <= 32; n++) {
    const ids = Array.from({ length: n }, (_, i) => String(i + 1)),
      games = roundRobin(ids),
      pairs = new Set(),
      rounds = new Map(),
      counts = new Map(ids.map((id) => [id, 0]));
    assert.equal(games.length, (n * (n - 1)) / 2);
    for (const game of games) {
      assert.notEqual(...game.teams);
      const pair = [...game.teams].sort().join('-');
      assert.ok(!pairs.has(pair));
      pairs.add(pair);
      const used = rounds.get(game.round) || new Set();
      for (const id of game.teams) {
        assert.ok(!used.has(id));
        used.add(id);
        counts.set(id, counts.get(id) + 1);
      }
      rounds.set(game.round, used);
    }
    assert.ok([...counts.values()].every((count) => count === n - 1));
    assert.equal(rounds.size, n % 2 ? n : n - 1);
  }
});
test(
  'tournament API persists fixed pairs, attendance, equal schedule and atomic/idempotent results',
  { skip: !process.env.DATABASE_URL },
  async () => {
    const schema = `tour_test_${randomUUID().replaceAll('-', '')}`,
      admin = createPool(process.env.DATABASE_URL),
      pool = createPool(process.env.DATABASE_URL, schema);
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await migrate(pool);
      await migrate(pool);
      const fixture = await adminFixture(pool),
        players = createPlayerService(pool),
        roster = [];
      for (let i = 0; i < 6; i++)
        roster.push(
          await players.save(null, {
            name: 'Player ' + i,
            username: 'tour_' + i,
            avatar: '',
            password: 'test-player-pass',
          }),
        );
      roster[5] = await players.createGuest({ id: randomUUID(), name: 'Guest tournament player' });
      const service = createTournamentService(pool),
        handle = createHandler(createRepository(pool), pool);
      const call = async (path, method = 'GET', body, headers = fixture.headers) => {
        const response = await handle(
          new Request('https://app.example/api' + path, {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
        return { status: response.status, data: await response.json() };
      };
      const input = {
        id: randomUUID(),
        target: 16,
        teams: Array.from({ length: 3 }, (_, i) => ({
          playerIds: [roster[i * 2].id, roster[i * 2 + 1].id],
        })),
      };
      const viewer = await createAuth(pool).login({
          username: roster[0].username,
          password: 'test-player-pass',
        }),
        viewerHeaders = { ...fixture.headers, Cookie: 'ibadz_session=' + viewer.token };
      assert.equal((await call('/tournaments', 'POST', input, viewerHeaders)).status, 201);
      const created = await call('/tournaments', 'POST', input);
      assert.equal(created.status, 201);
      const tournament = created.data.tournament;
      assert.equal(tournament.teams.length, 3);
      assert.equal(tournament.games.length, 3);
      assert.equal(tournament.target, 16);
      assert.ok(
        tournament.teams.some((team) => team.names.includes(roster[5].name)),
        'guest name persists in tournament team',
      );
      assert.equal((await call('/tournaments', 'GET', undefined, viewerHeaders)).data.total, 1);
      assert.equal(
        (await call('/tournaments/' + tournament.id, 'GET', undefined, viewerHeaders)).status,
        200,
      );
      assert.deepEqual((await service.create(input, fixture.player.id)).games, tournament.games);
      await assert.rejects(
        service.create({ ...input, target: 15 }, fixture.player.id),
        (e) => e.status === 409,
      );
      await assert.rejects(
        service.create(
          { ...input, id: randomUUID(), teams: [input.teams[0], input.teams[0]] },
          fixture.player.id,
        ),
        (e) => e.status === 400,
      );
      await assert.rejects(
        service.create({ ...input, id: randomUUID(), teams: [input.teams[0]] }, fixture.player.id),
        (e) => e.status === 400,
      );
      const game = tournament.games[0];
      assert.equal(
        (
          await call(
            `/tournaments/${tournament.id}/games/${game.id}/result`,
            'POST',
            { scores: [17, 15] },
            viewerHeaders,
          )
        ).status,
        403,
      );
      await assert.rejects(
        service.finish(tournament.id, game.id, { scores: [16, 15] }),
        (e) => e.status === 400,
      );
      await assert.rejects(
        service.finish(tournament.id, game.id, { scores: [15, 15] }),
        (e) => e.status === 400,
      );
      const result = await service.finish(tournament.id, game.id, { scores: [17, 15] });
      assert.equal(result.tournament.games.filter((g) => g.scores).length, 1);
      assert.ok(result.session.matches.some((m) => m.id === game.id));
      const repeat = await service.finish(tournament.id, game.id, { scores: [17, 15] });
      assert.equal(repeat.session.version, result.session.version);
      await assert.rejects(
        service.finish(tournament.id, game.id, { scores: [18, 16] }),
        (e) => e.status === 409,
      );
      const simultaneous = await Promise.all([
        service.finish(tournament.id, tournament.games[1].id, { scores: [16, 10] }),
        service.finish(tournament.id, tournament.games[1].id, { scores: [16, 10] }),
      ]);
      assert.equal(simultaneous[0].session.version, simultaneous[1].session.version);
      for (const pending of tournament.games.slice(2))
        await service.finish(tournament.id, pending.id, { scores: [16, 10] });
      assert.equal((await service.get(tournament.id)).games.filter((g) => g.scores).length, 3);
      assert.equal((await service.list()).tournaments[0].finishedCount, 3);
      await players.save(
        roster[0].id,
        { name: roster[0].name, username: roster[0].username, avatar: '', status: 'inactive' },
        fixture.player,
      );
      await assert.rejects(
        service.create({ ...input, id: randomUUID() }, fixture.player.id),
        (e) => e.status === 400,
      );
      assert.equal((await service.get(tournament.id)).teams[0].names[0], roster[0].name);
      const other = await service.create(
        { id: randomUUID(), target: 1, teams: [input.teams[1], input.teams[2]] },
        fixture.player.id,
      );
      const one = await service.finish(other.id, other.games[0].id, { scores: [1, 0] });
      const countBefore = (await pool.query('SELECT count(*)::integer AS total FROM rally_matches'))
        .rows[0].total;
      assert.equal(
        (await pool.query('SELECT created_by FROM rally_tournaments WHERE id=$1', [tournament.id]))
          .rows[0].created_by,
        roster[0].id,
      );
      const activeViewer = await createAuth(pool).login({
        username: roster[1].username,
        password: 'test-player-pass',
      });
      const activeViewerHeaders = {
        ...fixture.headers,
        Cookie: 'ibadz_session=' + activeViewer.token,
      };
      assert.equal(
        (await call('/tournaments/' + tournament.id, 'DELETE', undefined, activeViewerHeaders))
          .status,
        403,
      );
      assert.equal((await call('/tournaments/' + tournament.id, 'DELETE')).status, 200);
      assert.equal(
        (await call('/tournaments/' + tournament.id, 'DELETE')).status,
        200,
        'deletion retries are idempotent',
      );
      await assert.rejects(service.get(tournament.id), (e) => e.status === 404);
      await assert.rejects(
        service.finish(tournament.id, game.id, { scores: [17, 15] }),
        (e) => e.status === 404,
      );
      await assert.rejects(service.create(input, fixture.player.id), (e) => e.status === 409);
      assert.equal((await service.list()).total, 1);
      assert.equal(
        (await pool.query('SELECT count(*)::integer AS total FROM rally_matches')).rows[0].total,
        countBefore,
        'daily history must remain unchanged',
      );

      assert.equal(one.tournament.games[0].scores[0], 1);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
