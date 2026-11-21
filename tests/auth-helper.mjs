import { createPlayerService } from '../src/players.mjs';
import { createAuth } from '../src/auth.mjs';
export async function adminFixture(pool) {
  const player = await createPlayerService(pool).save(null, {
    name: 'Bootstrap',
    username: 'bootstrap_admin',
    avatar: '',
    password: 'test-admin-pass',
  });
  await pool.query('UPDATE rally_players SET role_id=1 WHERE id=$1', [player.id]);
  const login = await createAuth(pool).login({
    username: player.username,
    password: 'test-admin-pass',
  });
  return {
    player,
    headers: {
      'Content-Type': 'application/json',
      'X-Requested-With': 'ibadz',
      Cookie: `ibadz_session=${login.token}`,
    },
  };
}
