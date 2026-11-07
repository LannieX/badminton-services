import { createServer } from 'node:http';
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
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json'))
    throw new ApiError(415, 'กรุณาส่งข้อมูลเป็น JSON');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256000) throw new ApiError(413, 'ข้อมูลมีขนาดใหญ่เกินไป');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
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
export function createApp(repository, pool) {
  return createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, data) => {
      res.writeHead(status);
      res.end(JSON.stringify(data));
    };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
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
      if (!res.headersSent) send(503, { error: 'เชื่อมต่อฐานข้อมูลไม่สำเร็จ กรุณาลองอีกครั้ง' });
      else res.end();
    }
  });
}
