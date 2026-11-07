import { createPool, migrate } from './db.mjs';
const pool = createPool(process.env.DATABASE_URL);
try {
  await migrate(pool);
  console.log('Database schema ready');
} finally {
  await pool.end();
}
