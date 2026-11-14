import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createHandler } from './handler.mjs';

export function createApp(repository, pool) {
  const handle = createHandler(repository, pool);
  return createServer(async (req, res) => {
    try {
      const request = new Request(new URL(req.url, 'http://localhost'), {
        method: req.method,
        headers: req.headers,
        ...(['GET', 'HEAD'].includes(req.method)
          ? {}
          : { body: Readable.toWeb(req), duplex: 'half' }),
      });
      const response = await handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'รูปแบบคำขอไม่ถูกต้อง' }));
      } else res.end();
    }
  });
}
