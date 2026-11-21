import { assertPaymentManager } from './billing.mjs';
import { createTournamentService } from './tournaments.mjs';
import { createAuth, sessionCookie, cookieToken, SESSION_MAX_AGE } from './auth.mjs';
import { createPlayerService, profileInput } from './players.mjs';
import {
  sessionInput,
  matchInput,
  updateInput,
  importInput,
  paymentInput,
  paymentEditInput,
  paymentVersionInput,
  paymentIdInput,
} from './validation.mjs';
import { ApiError } from './repository.mjs';
async function body(req) {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
    throw new ApiError(415, 'กรุณาส่งข้อมูลเป็น JSON');
  let size = 0;
  const chunks = [];
  if (req.body) {
    const reader = req.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 256000) {
          await reader.cancel();
          throw new ApiError(413, 'ข้อมูลมีขนาดใหญ่เกินไป');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, 'รูปแบบ JSON ไม่ถูกต้อง');
  }
}
function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ApiError(400, 'ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบชื่อ วันที่ คะแนน หรือจำนวนเงิน');
  return result.data;
}
export function createHandler(repository, pool, env = {}) {
  const players = createPlayerService(pool, env);
  const auth = createAuth(pool);
  const tournaments = createTournamentService(pool);
  return async (req) => {
    const send = (status, data, headers = {}) =>
      Response.json(data, {
        status,
        headers: {
          ...headers,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    try {
      const path = new URL(req.url).pathname;
      if (req.method === 'GET' && path === '/api/health') {
        await pool.query('SELECT 1');
        return send(200, { status: 'ok', database: 'connected' });
      }
      if (
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        req.headers.get('X-Requested-With') !== 'ibadz'
      )
        throw new ApiError(403, 'คำขอไม่ได้รับอนุญาต');
      if (req.method === 'POST' && path === '/api/auth/login') {
        const result = await auth.login(await body(req));
        return send(200, { user: result.user }, { 'Set-Cookie': sessionCookie(req, result.token) });
      }
      if (req.method === 'POST' && path === '/api/auth/logout') {
        await auth.logout(req);
        return send(200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', true) });
      }
      const actor = await auth.current(req);
      if (!actor) return send(401, { error: 'กรุณาเข้าสู่ระบบ', code: 'SESSION_INVALID' });
      if (req.method === 'GET' && path === '/api/auth/me') {
        const { _sessionExpiresAt, ...user } = actor;
        const remaining = _sessionExpiresAt
          ? Math.max(0, Math.floor((new Date(_sessionExpiresAt).getTime() - Date.now()) / 1000))
          : SESSION_MAX_AGE;
        return send(
          200,
          { user },
          { 'Set-Cookie': sessionCookie(req, cookieToken(req), false, remaining) },
        );
      }
      if (req.method === 'PUT' && path === '/api/auth/me')
        return send(200, {
          user: await players.save(actor.id, parse(profileInput, await body(req)), actor),
        });
      if (req.method === 'POST' && path === '/api/tournaments')
        return send(201, { tournament: await tournaments.create(await body(req), actor.id) });
      if (req.method === 'POST' && path === '/api/guests')
        return send(201, { player: await players.createGuest(await body(req)) });
      if (req.method === 'POST' && path === '/api/payment-requests')
        return send(200, {
          session: await repository.createPayment(parse(paymentInput, await body(req)), actor.id),
        });
      const paidPath = path.match(
        /^\/api\/payment-requests\/([0-9a-f-]+)\/members\/([0-9a-f-]+)$/i,
      );
      if (paidPath && req.method === 'PATCH') {
        await assertPaymentManager(pool, actor, parse(paymentIdInput, paidPath[1]));
        const input = await body(req);
        if (
          typeof input?.paid !== 'boolean' ||
          !Number.isInteger(input.version) ||
          input.version < 1
        )
          throw new ApiError(400, 'ข้อมูลการชำระเงินไม่ถูกต้อง');
        return send(200, {
          session: await repository.markPaid(
            parse(paymentIdInput, paidPath[1]),
            parse(paymentIdInput, paidPath[2]),
            input,
            actor.id,
          ),
        });
      }
      const paymentPath = path.match(/^\/api\/sessions\/([^/]+)\/payment-requests\/([^/]+)$/);
      if (paymentPath && (req.method === 'PUT' || req.method === 'DELETE')) {
        const sessionId = decodeURIComponent(paymentPath[1]);
        const id = parse(paymentIdInput, decodeURIComponent(paymentPath[2]));
        await assertPaymentManager(pool, actor, id);
        const input = parse(
          req.method === 'PUT' ? paymentEditInput : paymentVersionInput,
          await body(req),
        );
        return send(200, {
          session: await repository.mutatePayment(
            sessionId,
            id,
            input.version,
            req.method === 'PUT' ? input.payment : null,
          ),
        });
      }
      if (req.method === 'POST' && path === '/api/matches')
        return send(200, { session: await repository.finish(parse(matchInput, await body(req))) });
      if (req.method !== 'GET' && actor.role !== 'admin')
        throw new ApiError(403, 'เฉพาะ admin เท่านั้นที่แก้ไขข้อมูลได้');
      if (req.method === 'GET' && path === '/api/tournaments')
        return send(
          200,
          await tournaments.list(Number(new URL(req.url).searchParams.get('page') || 1)),
        );
      const tournamentPath = path.match(
        /^\/api\/tournaments\/([0-9a-f-]+)(?:\/games\/([0-9a-f-]+)\/result)?$/i,
      );
      if (tournamentPath) {
        const id = parse(paymentIdInput, tournamentPath[1]);
        if (req.method === 'DELETE' && !tournamentPath[2])
          return send(200, await tournaments.delete(id));
        if (req.method === 'GET' && !tournamentPath[2])
          return send(200, { tournament: await tournaments.get(id) });
        if (req.method === 'POST' && tournamentPath[2])
          return send(
            200,
            await tournaments.finish(id, parse(paymentIdInput, tournamentPath[2]), await body(req)),
          );
      }
      if (req.method === 'GET' && path === '/api/players') {
        const params = new URL(req.url).searchParams;
        const query = params.get('q') || '';
        if (params.has('page') || params.has('pageSize'))
          return send(
            200,
            await players.listPage(
              query,
              Number(params.get('page') || 1),
              Number(params.get('pageSize') || 10),
            ),
          );
        return send(200, { players: await players.list(query) });
      }
      if (req.method === 'POST' && path === '/api/players')
        return send(201, { player: await players.save(null, await body(req), actor) });
      const playerPath = path.match(/^\/api\/players\/([0-9a-f-]+)$/i);
      if (playerPath && ['PUT', 'DELETE'].includes(req.method)) {
        const id = playerPath[1];
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
          throw new ApiError(400, 'รหัสผู้เล่นไม่ถูกต้อง');
        if (req.method === 'PUT')
          return send(200, { player: await players.save(id, await body(req), actor) });
        throw new ApiError(
          405,
          'สมาชิกมีประวัติการชำระเงิน กรุณาเปลี่ยนสถานะเป็น inactive แทนการลบ',
        );
      }
      if (req.method === 'POST' && path === '/api/import') {
        const input = parse(importInput, await body(req));
        return send(200, { sessions: await repository.importSessions(input.sessions) });
      }
      if (req.method === 'GET' && path === '/api/sessions')
        return send(200, { sessions: await repository.list() });
      if (req.method === 'POST' && path === '/api/sessions')
        return send(201, {
          session: await repository.create(parse(sessionInput, await body(req))),
        });
      if (req.method === 'PUT' && path.startsWith('/api/sessions/'))
        return send(200, {
          session: await repository.update(
            decodeURIComponent(path.slice('/api/sessions/'.length)),
            parse(updateInput, await body(req)),
          ),
        });
      return send(404, { error: 'ไม่พบ API ที่เรียกใช้งาน' });
    } catch (e) {
      if (e instanceof ApiError) return send(e.status, { error: e.message });
      // Avoid logging SQL parameters, connection strings or user payloads.
      console.error('API failure', { code: typeof e.code === 'string' ? e.code : 'internal' });
      return send(503, { error: 'เชื่อมต่อฐานข้อมูลไม่สำเร็จ กรุณาลองอีกครั้ง' });
    }
  };
}
