import pg from 'pg';
export function createPool(connectionString, schema = 'public') {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('Invalid database schema');
  const url = new URL(connectionString);
  if (url.searchParams.get('sslmode') === 'require') url.searchParams.set('sslmode', 'verify-full');
  // Schema-isolated tests use Neon's direct endpoint; the transaction pooler disallows search_path startup options.
  if (schema !== 'public') url.hostname = url.hostname.replace('-pooler', '');
  return new pg.Pool({
    connectionString: url.toString(),
    enableChannelBinding: true,
    max: 5,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    query_timeout: 15000,
    ...(schema === 'public' ? {} : { options: `-c search_path=${schema}` }),
  });
}
export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(72101342)`);
    await client.query(`CREATE TABLE IF NOT EXISTS rally_sessions (
      id text PRIMARY KEY,
      name text NOT NULL,
      date date NOT NULL,
      expenses jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(expenses)='array'),
      members jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(members)='array'),
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS rally_matches (
      id uuid PRIMARY KEY,
      session_id text NOT NULL REFERENCES rally_sessions(id),
      time timestamptz NOT NULL,
      mode text NOT NULL CHECK (mode IN ('single','double')),
      names jsonb NOT NULL CHECK (jsonb_array_length(names)=2),
      scores jsonb NOT NULL CHECK (jsonb_array_length(scores)=2),
      target integer NOT NULL CHECK (target BETWEEN 1 AND 999),
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query(
      'CREATE INDEX IF NOT EXISTS rally_matches_session_idx ON rally_matches(session_id, time DESC)',
    );
    await client.query(`CREATE TABLE IF NOT EXISTS rally_payment_requests (
      id uuid PRIMARY KEY,
      session_id text NOT NULL REFERENCES rally_sessions(id),
      total_cents integer NOT NULL CHECK (total_cents BETWEEN 1 AND 999999900),
      player_count integer NOT NULL CHECK (player_count BETWEEN 1 AND 500),
      method text NOT NULL CHECK (method IN ('promptpay','bank')),
      recipient text NOT NULL,
      bank_code text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (total_cents >= player_count)
    )`);
    await client.query(
      'CREATE INDEX IF NOT EXISTS rally_payment_requests_session_idx ON rally_payment_requests(session_id,created_at DESC)',
    );
    await client.query(
      'ALTER TABLE rally_payment_requests ADD COLUMN IF NOT EXISTS deleted_at timestamptz',
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
