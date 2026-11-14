import { Pool } from '@neondatabase/serverless';
import { createRepository } from './repository.mjs';
import { createHandler } from './handler.mjs';

function json(status, error) {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function createWorker(
  createDatabase = (url) =>
    new Pool({
      connectionString: url,
      max: 1,
      connectionTimeoutMillis: 15000,
      query_timeout: 15000,
    }),
) {
  return {
    async fetch(request, env, ctx) {
      const origin = request.headers.get('Origin');
      const allowed = (env.ALLOWED_ORIGINS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const cors = new Headers({
        Vary: 'Origin',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      if (origin && !allowed.includes(origin)) return json(403, 'Origin นี้ไม่ได้รับอนุญาต');
      if (origin) cors.set('Access-Control-Allow-Origin', origin);
      if (request.method === 'OPTIONS') {
        cors.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        cors.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
        cors.set('Access-Control-Max-Age', '600');
        return new Response(null, { status: 204, headers: cors });
      }
      const respond = (response) => {
        const headers = new Headers(response.headers);
        for (const [key, value] of cors) headers.set(key, value);
        return new Response(response.body, { status: response.status, headers });
      };
      
      if (!env.DATABASE_URL) return respond(json(503, 'ยังไม่ได้ตั้งค่าฐานข้อมูล'));
      const pool = createDatabase(env.DATABASE_URL);
      pool.on('error', () => console.error('Database connection error'));
      try {
        return respond(await createHandler(createRepository(pool), pool)(request));
      } finally {
        ctx.waitUntil(pool.end().catch(() => console.error('Database cleanup error')));
      }
    },
  };
}

export default createWorker();
