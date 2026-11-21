import { z } from 'zod';
import { ApiError, sessionSelect } from './repository.mjs';
const creation = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(100).optional(),
    target: z.number().int().min(1).max(999),
    teams: z
      .array(z.object({ playerIds: z.tuple([z.uuid(), z.uuid()]) }).strict())
      .min(2)
      .max(32),
  })
  .strict()
  .refine((v) => new Set(v.teams.flatMap((t) => t.playerIds)).size === v.teams.length * 2);
const scoreInput = z
  .object({
    scores: z.tuple([z.number().int().min(0).max(10000), z.number().int().min(0).max(10000)]),
  })
  .strict();
export function roundRobin(ids) {
  if (ids.length < 2 || new Set(ids).size !== ids.length) throw new Error('Invalid teams');
  const ring = [...ids];
  if (ring.length % 2) ring.push(null);
  const games = [];
  for (let round = 1; round < ring.length; round++) {
    for (let i = 0; i < ring.length / 2; i++) {
      const a = ring[i],
        b = ring[ring.length - 1 - i];
      if (a && b) games.push({ round, teams: round % 2 ? [a, b] : [b, a] });
    }
    ring.splice(1, 0, ring.pop());
  }
  return games;
}
const selection = `SELECT t.id,t.name,t.target,t.teams,t.created_at AS "createdAt",COALESCE((SELECT jsonb_agg(jsonb_build_object('id',g.id,'round',g.round,'teams',jsonb_build_array(g.home_team,g.away_team),'scores',g.scores,'finishedAt',g.finished_at) ORDER BY g.round,g.id) FROM rally_tournament_games g WHERE g.tournament_id=t.id),'[]'::jsonb) AS games FROM rally_tournaments t`;
export function createTournamentService(pool) {
  const get = async (id, db = pool) => {
    const v = (await db.query(selection + ' WHERE t.id=$1 AND t.deleted_at IS NULL', [id])).rows[0];
    if (!v) throw new ApiError(404, 'ไม่พบทัวร์นาเมนต์นี้');
    return v;
  };
  return {
    get,
    async list(page = 1) {
      if (!Number.isInteger(page) || page < 1 || page > 1000000)
        throw new ApiError(400, 'กรุณาเลือกหน้าให้ถูกต้อง');
      const total = (
        await pool.query(
          'SELECT count(*)::integer AS total FROM rally_tournaments WHERE deleted_at IS NULL',
        )
      ).rows[0].total;
      page = Math.min(page, Math.max(1, Math.ceil(total / 10)));
      const tournaments = (
        await pool.query(
          `SELECT t.id,t.name,t.target,jsonb_array_length(t.teams) AS "teamCount",t.created_at AS "createdAt",(SELECT count(*)::integer FROM rally_tournament_games g WHERE g.tournament_id=t.id) AS "gameCount",(SELECT count(*)::integer FROM rally_tournament_games g WHERE g.tournament_id=t.id AND g.scores IS NOT NULL) AS "finishedCount" FROM rally_tournaments t WHERE t.deleted_at IS NULL ORDER BY t.created_at DESC,t.id LIMIT 10 OFFSET $1`,
          [(page - 1) * 10],
        )
      ).rows;
      return { tournaments, total, page, pageSize: 10 };
    },
    async create(raw, actorId) {
      const result = creation.safeParse(raw);
      if (!result.success)
        throw new ApiError(400, 'เลือกผู้ร่วมเล่น 4–64 คน จัดคู่ให้ครบและไม่ซ้ำ แล้วเลือกคะแนน');
      const input = result.data,
        ids = input.teams.flatMap((t) => t.playerIds),
        db = await pool.connect();
      try {
        await db.query('BEGIN');
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [input.id]);
        const old = (await db.query('SELECT * FROM rally_tournaments WHERE id=$1', [input.id]))
          .rows[0];
        if (old) {
          if (old.deleted_at)
            throw new ApiError(409, 'ทัวร์นาเมนต์นี้ถูกลบแล้ว กรุณาสร้างรายการใหม่');
          if (
            old.target !== input.target ||
            (input.name && old.name !== input.name) ||
            JSON.stringify(old.teams.map((t) => t.playerIds)) !==
              JSON.stringify(input.teams.map((t) => t.playerIds))
          )
            throw new ApiError(409, 'รายการนี้ถูกสร้างด้วยข้อมูลอื่นแล้ว กรุณาเปิดรายการล่าสุด');
          const saved = await get(input.id, db);
          await db.query('COMMIT');
          return saved;
        }
        const players = (
          await db.query(
            'SELECT id,name,status FROM rally_players WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
            [ids],
          )
        ).rows;
        if (players.length !== ids.length || players.some((p) => p.status !== 'active'))
          throw new ApiError(400, 'มีสมาชิกที่ไม่พร้อมใช้งาน กรุณาตรวจสอบรายชื่ออีกครั้ง');
        const names = new Map(players.map((p) => [p.id, p.name]));
        const teams = input.teams.map((t) => ({
          id: crypto.randomUUID(),
          playerIds: t.playerIds,
          names: t.playerIds.map((id) => names.get(id)),
        }));
        const title =
          input.name ||
          'ทัวร์นาเมนต์ ' + new Date().toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' });
        await db.query(
          'INSERT INTO rally_tournaments(id,name,target,teams,created_by) VALUES($1,$2,$3,$4,$5)',
          [input.id, title, input.target, JSON.stringify(teams), actorId],
        );
        await db.query(
          'INSERT INTO rally_tournament_players(tournament_id,player_id) SELECT $1,unnest($2::uuid[])',
          [input.id, ids],
        );
        const games = roundRobin(teams.map((t) => t.id)).map((g) => ({
          id: crypto.randomUUID(),
          round: g.round,
          home_team: g.teams[0],
          away_team: g.teams[1],
        }));
        await db.query(
          'INSERT INTO rally_tournament_games(id,tournament_id,round,home_team,away_team) SELECT id,$1,round,home_team,away_team FROM jsonb_to_recordset($2::jsonb) AS g(id uuid,round integer,home_team uuid,away_team uuid)',
          [input.id, JSON.stringify(games)],
        );
        const saved = await get(input.id, db);
        await db.query('COMMIT');
        return saved;
      } catch (e) {
        await db.query('ROLLBACK');
        throw e;
      } finally {
        db.release();
      }
    },
    async delete(id) {
      const result = await pool.query(
        'UPDATE rally_tournaments SET deleted_at=COALESCE(deleted_at,now()) WHERE id=$1 RETURNING id',
        [id],
      );
      if (!result.rowCount) throw new ApiError(404, 'ไม่พบทัวร์นาเมนต์นี้');
      return { deleted: true };
    },
    async finish(id, gameId, raw) {
      const parsed = scoreInput.safeParse(raw);
      if (!parsed.success) throw new ApiError(400, 'คะแนนไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง');
      const scores = parsed.data.scores,
        db = await pool.connect();
      try {
        await db.query('BEGIN');
        const tournament = (
          await db.query(
            'SELECT * FROM rally_tournaments WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
            [id],
          )
        ).rows[0];
        if (!tournament) throw new ApiError(404, 'ไม่พบทัวร์นาเมนต์นี้');
        const game = (
          await db.query(
            'SELECT * FROM rally_tournament_games WHERE id=$1 AND tournament_id=$2 FOR UPDATE',
            [gameId, id],
          )
        ).rows[0];
        if (!game) throw new ApiError(404, 'ไม่พบแมตช์นี้');
        if (
          Math.max(...scores) < tournament.target ||
          Math.abs(scores[0] - scores[1]) < (tournament.target === 1 ? 1 : 2)
        )
          throw new ApiError(400, 'เกมยังไม่จบ กรุณาตรวจสอบคะแนนอีกครั้ง');
        let sessionId;
        if (game.scores) {
          if (JSON.stringify(game.scores) !== JSON.stringify(scores))
            throw new ApiError(409, 'แมตช์นี้มีผลแล้ว กรุณาตรวจสอบผลล่าสุด');
          sessionId = (
            await db.query('SELECT session_id FROM rally_matches WHERE id=$1', [game.match_id])
          ).rows[0].session_id;
        } else {
          const now = new Date(),
            date = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
          sessionId = 'daily:' + date;
          const name =
            'ก๊วน' + now.toLocaleDateString('th-TH', { weekday: 'long', timeZone: 'Asia/Bangkok' });
          await db.query(
            'INSERT INTO rally_sessions(id,name,date) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
            [sessionId, name, date],
          );
          await db.query('SELECT id FROM rally_sessions WHERE id=$1 FOR UPDATE', [sessionId]);
          const names = [game.home_team, game.away_team].map((id) =>
            tournament.teams.find((t) => t.id === id).names.join(' / '),
          );
          await db.query(
            "INSERT INTO rally_matches(id,session_id,time,mode,names,scores,target) VALUES($1,$2,$3,'double',$4,$5,$6)",
            [
              game.id,
              sessionId,
              now.toISOString(),
              JSON.stringify(names),
              JSON.stringify(scores),
              tournament.target,
            ],
          );
          await db.query(
            'UPDATE rally_tournament_games SET scores=$2,match_id=$1,finished_at=now() WHERE id=$1',
            [game.id, JSON.stringify(scores)],
          );
          await db.query(
            'UPDATE rally_sessions SET version=version+1,updated_at=now() WHERE id=$1',
            [sessionId],
          );
        }
        const saved = await get(id, db),
          session = (await db.query(sessionSelect + ' WHERE s.id=$1', [sessionId])).rows[0];
        await db.query('COMMIT');
        return { tournament: saved, session };
      } catch (e) {
        await db.query('ROLLBACK');
        throw e;
      } finally {
        db.release();
      }
    },
  };
}
