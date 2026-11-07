export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const sessionSelect = `SELECT s.id,s.name,s.date::text,s.expenses,s.members,s.version,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'sessionId',p.session_id,'totalCents',p.total_cents,'playerCount',p.player_count,'method',p.method,'recipient',p.recipient,'bankCode',p.bank_code,'createdAt',p.created_at) ORDER BY p.created_at DESC,p.id) FROM rally_payment_requests p WHERE p.session_id=s.id AND p.deleted_at IS NULL),'[]'::jsonb) AS "paymentRequests",
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'time',m.time,'mode',m.mode,'names',m.names,'scores',m.scores,'target',m.target) ORDER BY m.time DESC,m.id) FROM rally_matches m WHERE m.session_id=s.id),'[]'::jsonb) AS matches FROM rally_sessions s`;
export function createRepository(pool) {
  const get = async (id, db = pool) =>
    (await db.query(sessionSelect + ' WHERE s.id=$1', [id])).rows[0];
  return {
    async importSessions(sessions) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const session of [...sessions].sort((a, b) => a.id.localeCompare(b.id))) {
          const inserted = await client.query(
            'INSERT INTO rally_sessions(id,name,date,expenses,members) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING RETURNING id',
            [
              session.id,
              session.name,
              session.date,
              JSON.stringify(session.expenses),
              JSON.stringify(session.members),
            ],
          );
          const current = (
            await client.query('SELECT * FROM rally_sessions WHERE id=$1 FOR UPDATE', [session.id])
          ).rows[0];
          if (!inserted.rowCount) {
            const expenses = [
              ...current.expenses,
              ...session.expenses.filter((e) => !current.expenses.some((x) => x.id === e.id)),
            ];
            const members = [
              ...current.members,
              ...session.members.filter((m) => !current.members.some((x) => x.id === m.id)),
            ];
            if (
              expenses.length !== current.expenses.length ||
              members.length !== current.members.length
            ) {
              await client.query(
                'UPDATE rally_sessions SET expenses=$2,members=$3,version=version+1,updated_at=now() WHERE id=$1',
                [
                  session.id,
                  JSON.stringify(expenses),
                  JSON.stringify(members.map((m) => ({ ...m, paid: false }))),
                ],
              );
            }
          }
          for (const match of session.matches) {
            const added = await client.query(
              'INSERT INTO rally_matches(id,session_id,time,mode,names,scores,target) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING id',
              [
                match.id,
                session.id,
                match.time,
                match.mode,
                JSON.stringify(match.names),
                JSON.stringify(match.scores),
                match.target,
              ],
            );
            if (added.rowCount)
              await client.query('UPDATE rally_sessions SET version=version+1 WHERE id=$1', [
                session.id,
              ]);
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return (await pool.query(sessionSelect + ' ORDER BY s.date DESC,s.created_at DESC')).rows;
    },
    async createPayment(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [input.id]);
        const existing = (
          await client.query('SELECT * FROM rally_payment_requests WHERE id=$1', [input.id])
        ).rows[0];
        if (existing) {
          if (existing.deleted_at)
            throw new ApiError(409, 'รายการนี้ถูกลบแล้ว กรุณาเพิ่มรายการใหม่');
          if (
            existing.total_cents !== input.totalCents ||
            existing.player_count !== input.playerCount ||
            existing.method !== input.method ||
            existing.recipient !== input.recipient ||
            (existing.bank_code || undefined) !== input.bankCode
          )
            throw new ApiError(409, 'รายการนี้ถูกบันทึกแล้วด้วยข้อมูลอื่น');
          const saved = await get(existing.session_id, client);
          await client.query('COMMIT');
          return saved;
        }
        let sessionId = input.sessionId;
        if (sessionId) {
          if (
            !(
              await client.query('SELECT id FROM rally_sessions WHERE id=$1 FOR UPDATE', [
                sessionId,
              ])
            ).rowCount
          )
            throw new ApiError(404, 'ไม่พบรอบเล่น กรุณาโหลดข้อมูลใหม่');
        } else {
          const now = new Date();
          const date = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
          sessionId = 'daily:' + date;
          const name =
            'ก๊วน' + now.toLocaleDateString('th-TH', { weekday: 'long', timeZone: 'Asia/Bangkok' });
          await client.query(
            'INSERT INTO rally_sessions(id,name,date) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
            [sessionId, name, date],
          );
        }
        await client.query(
          'INSERT INTO rally_payment_requests(id,session_id,total_cents,player_count,method,recipient,bank_code) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            input.id,
            sessionId,
            input.totalCents,
            input.playerCount,
            input.method,
            input.recipient,
            input.bankCode || null,
          ],
        );
        await client.query(
          'UPDATE rally_sessions SET version=version+1,updated_at=now() WHERE id=$1',
          [sessionId],
        );
        const saved = await get(sessionId, client);
        await client.query('COMMIT');
        return saved;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async mutatePayment(sessionId, id, version, payment = null) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const session = (
          await client.query('SELECT version FROM rally_sessions WHERE id=$1 FOR UPDATE', [
            sessionId,
          ])
        ).rows[0];
        if (!session) throw new ApiError(404, 'ไม่พบรอบเล่น');
        const existing = (
          await client.query(
            'SELECT * FROM rally_payment_requests WHERE id=$1 AND session_id=$2 FOR UPDATE',
            [id, sessionId],
          )
        ).rows[0];
        if (!existing) throw new ApiError(404, 'ไม่พบรายการค่าใช้จ่าย');
        if (
          payment &&
          (payment.id !== id || (payment.sessionId && payment.sessionId !== sessionId))
        )
          throw new ApiError(400, 'รหัสรายการหรือรอบเล่นไม่ตรงกัน');
        if (payment && existing.deleted_at) throw new ApiError(404, 'รายการนี้ถูกลบแล้ว');
        const unchanged =
          payment &&
          existing.total_cents === payment.totalCents &&
          existing.player_count === payment.playerCount &&
          existing.method === payment.method &&
          existing.recipient === payment.recipient &&
          (existing.bank_code || undefined) === payment.bankCode;
        if ((!payment && existing.deleted_at) || unchanged) {
          const saved = await get(sessionId, client);
          await client.query('COMMIT');
          return saved;
        }
        if (session.version !== version)
          throw new ApiError(
            409,
            'ข้อมูลถูกแก้ไขจากอุปกรณ์อื่น กรุณาตรวจสอบข้อมูลล่าสุดแล้วลองอีกครั้ง',
          );
        if (payment)
          await client.query(
            'UPDATE rally_payment_requests SET total_cents=$3,player_count=$4,method=$5,recipient=$6,bank_code=$7 WHERE id=$1 AND session_id=$2',
            [
              id,
              sessionId,
              payment.totalCents,
              payment.playerCount,
              payment.method,
              payment.recipient,
              payment.bankCode || null,
            ],
          );
        else
          await client.query(
            'UPDATE rally_payment_requests SET deleted_at=now() WHERE id=$1 AND session_id=$2',
            [id, sessionId],
          );
        await client.query(
          'UPDATE rally_sessions SET version=version+1,updated_at=now() WHERE id=$1',
          [sessionId],
        );
        const saved = await get(sessionId, client);
        await client.query('COMMIT');
        return saved;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async list() {
      return (await pool.query(sessionSelect + ' ORDER BY s.date DESC,s.created_at DESC')).rows;
    },
    async create(input) {
      const result = await pool.query(
        'INSERT INTO rally_sessions(id,name,date) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING RETURNING id',
        [input.id, input.name, input.date],
      );
      const saved = await get(input.id);
      if (!result.rowCount && (saved.name !== input.name || saved.date !== input.date))
        throw new ApiError(409, 'รหัสรอบเล่นนี้ถูกใช้แล้ว');
      return saved;
    },
    async update(id, input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const row = (
          await client.query('SELECT * FROM rally_sessions WHERE id=$1 FOR UPDATE', [id])
        ).rows[0];
        if (!row) throw new ApiError(404, 'ไม่พบรอบเล่น');
        if (row.version !== input.version)
          throw new ApiError(
            409,
            'ข้อมูลถูกแก้ไขจากอุปกรณ์อื่น กรุณาตรวจสอบข้อมูลล่าสุดแล้วลองอีกครั้ง',
          );
        const oldAmounts = row.expenses
          .map((e) => [e.id, e.amount])
          .sort()
          .toString();
        const newAmounts = input.expenses
          .map((e) => [e.id, e.amount])
          .sort()
          .toString();
        const changed =
          oldAmounts !== newAmounts ||
          row.members
            .map((m) => m.id)
            .sort()
            .toString() !==
            input.members
              .map((m) => m.id)
              .sort()
              .toString();
        const members = changed ? input.members.map((m) => ({ ...m, paid: false })) : input.members;
        await client.query(
          'UPDATE rally_sessions SET expenses=$2,members=$3,version=version+1,updated_at=now() WHERE id=$1',
          [id, JSON.stringify(input.expenses), JSON.stringify(members)],
        );
        const saved = await get(id, client);
        await client.query('COMMIT');
        return saved;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async finish(match) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Serialize retries for this match ID; clients can safely retry a timed-out request.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [match.id]);
        const previous = (
          await client.query(
            'SELECT session_id,mode,names,scores,target FROM rally_matches WHERE id=$1',
            [match.id],
          )
        ).rows[0];
        if (previous) {
          if (
            previous.mode !== match.mode ||
            JSON.stringify(previous.names) !== JSON.stringify(match.names) ||
            JSON.stringify(previous.scores) !== JSON.stringify(match.scores) ||
            previous.target !== match.target
          )
            throw new ApiError(409, 'เกมนี้ถูกบันทึกด้วยคะแนนอื่นแล้ว กรุณาโหลดข้อมูลล่าสุด');
          const saved = await get(previous.session_id, client);
          await client.query('COMMIT');
          return saved;
        }
        const now = new Date();
        const date = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
        const name = `ก๊วน${now.toLocaleDateString('th-TH', { weekday: 'long', timeZone: 'Asia/Bangkok' })}`;
        const id = `daily:${date}`;
        await client.query(
          'INSERT INTO rally_sessions(id,name,date) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
          [id, name, date],
        );
        await client.query('SELECT id FROM rally_sessions WHERE id=$1 FOR UPDATE', [id]);
        await client.query(
          'INSERT INTO rally_matches(id,session_id,time,mode,names,scores,target) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            match.id,
            id,
            now.toISOString(),
            match.mode,
            JSON.stringify(match.names),
            JSON.stringify(match.scores),
            match.target,
          ],
        );
        await client.query(
          'UPDATE rally_sessions SET version=version+1,updated_at=now() WHERE id=$1',
          [id],
        );
        const saved = await get(id, client);
        await client.query('COMMIT');
        return saved;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
  };
}
