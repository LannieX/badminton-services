import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { createPool, migrate } from './db.mjs';
import { hashPassword } from './players.mjs';
const username = process.argv[2]?.trim().toLowerCase();
const name = process.argv[3]?.trim() || username;
if (!/^[a-z0-9_.-]{3,40}$/.test(username || '') || name.length > 80) {
  console.error('Usage: npm run admin:create -- USERNAME "NAME"');
  process.exit(1);
}
let password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
if (!password) {
  if (!process.stdin.isTTY)
    throw new Error('Run interactively or set BOOTSTRAP_ADMIN_PASSWORD locally');
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      if (!muted) process.stdout.write(chunk, encoding);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write('New admin password (at least 8 characters): ');
  muted = true;
  password = await rl.question('');
  process.stdout.write('\n');
  process.stdout.write('Confirm password: ');
  const confirm = await rl.question('');
  process.stdout.write('\n');
  rl.close();
  if (password !== confirm) throw new Error('Passwords do not match');
}
if (password.length < 8 || password.length > 128 || password.trim().length < 8)
  throw new Error('Password must have 8–128 characters');
const pool = createPool(process.env.DATABASE_URL);
try {
  await migrate(pool);
  const hash = await hashPassword(password);
  await pool.query(
    `INSERT INTO rally_players(id,name,username,password_hash,role_id,status) VALUES($1,$2,$3,$4,1,'active') ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash,role_id=1,status='active',auth_version=rally_players.auth_version+1,updated_at=now()`,
    [crypto.randomUUID(), name, username, hash],
  );
  console.log('Admin account is ready. Existing sessions for this account were revoked.');
} finally {
  await pool.end();
}
