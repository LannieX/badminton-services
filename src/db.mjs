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
    await client.query(`CREATE TABLE IF NOT EXISTS rally_players (
      id uuid PRIMARY KEY,
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
      username text NOT NULL CHECK (username ~ '^[a-z0-9_.-]{3,40}$'),
      password_hash text,
      role text NOT NULL DEFAULT 'player' CHECK (role IN ('admin','player')),
      avatar_url text NOT NULL DEFAULT '',
      avatar_public_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS rally_players_username_idx ON rally_players(lower(username))',
    );
    await client.query(`CREATE TABLE IF NOT EXISTS rally_roles (
      id smallint PRIMARY KEY,
      name text NOT NULL UNIQUE CHECK (name IN ('admin','viewer'))
    )`);
    await client.query('ALTER TABLE rally_roles DROP CONSTRAINT IF EXISTS rally_roles_name_check');
    await client.query(
      `INSERT INTO rally_roles(id,name) VALUES(1,'admin'),(2,'viewer') ON CONFLICT(id) DO NOTHING`,
    );
    await client.query(
      `ALTER TABLE rally_players ADD COLUMN IF NOT EXISTS role_id smallint REFERENCES rally_roles(id)`,
    );
    // Keep the legacy role column until older deployed Workers have been replaced.
    await client.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='rally_players' AND column_name='role') THEN
        UPDATE rally_players SET role_id=CASE WHEN role='admin' THEN 1 ELSE 2 END WHERE role_id IS NULL;
      END IF;
    END $$`);
    await client.query('UPDATE rally_players SET role_id=2 WHERE role_id IS NULL');
    await client.query(
      'ALTER TABLE rally_players ALTER COLUMN role_id SET DEFAULT 2, ALTER COLUMN role_id SET NOT NULL',
    );
    await client.query('ALTER TABLE rally_roles DROP CONSTRAINT IF EXISTS rally_roles_name_check');
    await client.query("UPDATE rally_roles SET name='viewer' WHERE id=2 AND name='user'");
    await client.query(
      "ALTER TABLE rally_roles ADD CONSTRAINT rally_roles_name_check CHECK (name IN ('admin','viewer'))",
    );
    await client.query(
      "ALTER TABLE rally_players ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive'))",
    );
    await client.query(
      'ALTER TABLE rally_players ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 1',
    );
    await client.query(`CREATE TABLE IF NOT EXISTS rally_auth_sessions (
      token_hash text PRIMARY KEY, player_id uuid NOT NULL REFERENCES rally_players(id) ON DELETE CASCADE,
      auth_version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
    )`);
    await client.query(
      'CREATE INDEX IF NOT EXISTS rally_auth_player_idx ON rally_auth_sessions(player_id)',
    );
    await client.query(`CREATE TABLE IF NOT EXISTS rally_login_attempts (
      key text PRIMARY KEY, attempts integer NOT NULL, reset_at timestamptz NOT NULL
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS rally_payment_members (
      payment_id uuid NOT NULL REFERENCES rally_payment_requests(id),
      player_id uuid NOT NULL REFERENCES rally_players(id),
      position integer NOT NULL, amount_cents integer NOT NULL CHECK (amount_cents>0),
      paid_at timestamptz, confirmed_by uuid REFERENCES rally_players(id),
      PRIMARY KEY(payment_id,player_id)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS rally_tournaments (
      id uuid PRIMARY KEY, name text NOT NULL, target integer NOT NULL CHECK(target BETWEEN 1 AND 999),
      teams jsonb NOT NULL CHECK(jsonb_typeof(teams)='array'), created_by uuid NOT NULL REFERENCES rally_players(id), created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query(
      'ALTER TABLE rally_tournaments ADD COLUMN IF NOT EXISTS deleted_at timestamptz',
    );
    await client.query(`CREATE TABLE IF NOT EXISTS rally_tournament_players (
      tournament_id uuid NOT NULL REFERENCES rally_tournaments(id), player_id uuid NOT NULL REFERENCES rally_players(id), PRIMARY KEY(tournament_id,player_id)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS rally_tournament_games (
      id uuid PRIMARY KEY, tournament_id uuid NOT NULL REFERENCES rally_tournaments(id), round integer NOT NULL CHECK(round>0),
      home_team uuid NOT NULL, away_team uuid NOT NULL, scores jsonb, match_id uuid UNIQUE REFERENCES rally_matches(id), finished_at timestamptz,
      CHECK(home_team<>away_team), CHECK(scores IS NULL OR jsonb_array_length(scores)=2)
    )`);
    await client.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS rally_tournament_pair_idx ON rally_tournament_games(tournament_id,LEAST(home_team,away_team),GREATEST(home_team,away_team))',
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS rally_tournament_games_idx ON rally_tournament_games(tournament_id,round,id)',
    );
    await client.query(
      "ALTER TABLE rally_players ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'member' CHECK(kind IN ('member','guest'))",
    );
    await client.query(
      'ALTER TABLE rally_payment_requests ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES rally_players(id)',
    );
    // Extend still-valid sessions only; expired and revoked sessions stay invalid.
    await client.query(
      "UPDATE rally_auth_sessions SET expires_at=created_at+interval '15 days' WHERE expires_at>now() AND expires_at<created_at+interval '15 days'",
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
