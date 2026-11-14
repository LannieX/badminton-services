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
export function createHandler(repository, pool) {
  return async (req) => {
    const send = (status, data) =>
      Response.json(data, {
        status,
        headers: {
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
      if (req.method === 'POST' && path === '/api/payment-requests')
        return send(200, {
          session: await repository.createPayment(parse(paymentInput, await body(req))),
        });
      if (req.method === 'POST' && path === '/api/matches')
        return send(200, { session: await repository.finish(parse(matchInput, await body(req))) });
      const paymentPath = path.match(/^\/api\/sessions\/([^/]+)\/payment-requests\/([^/]+)$/);
      if (paymentPath && (req.method === 'PUT' || req.method === 'DELETE')) {
        const sessionId = decodeURIComponent(paymentPath[1]);
        const id = parse(paymentIdInput, decodeURIComponent(paymentPath[2]));
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
