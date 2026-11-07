import { createPool, migrate } from './db.mjs';
import { createRepository } from './repository.mjs';
import { createApp } from './app.mjs';
const pool = createPool(process.env.DATABASE_URL);
pool.on('error', (error) => console.error('Database pool error', { code: error.code }));
await migrate(pool);
const server = createApp(createRepository(pool), pool);
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3001);
server.listen(port, host, () => console.log(`Badminton API ready at http://${host}:${port}`));
async function shutdown() {
  server.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
