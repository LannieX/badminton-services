import { ApiError } from './repository.mjs';
export const SESSION_COOKIE = 'ibadz_session';
export const SESSION_MAX_AGE = 15 * 24 * 60 * 60;
const hex = (bytes) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
export async function digest(value) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}
export function cookieToken(request) {
  const value = request.headers
    .get('cookie')
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(SESSION_COOKIE + '='))
    ?.slice(SESSION_COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(value || '') ? value : null;
}
export function sessionCookie(request, token, clear = false, maxAge = SESSION_MAX_AGE) {
  return `${SESSION_COOKIE}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : maxAge}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
export async function verifyPassword(password, encoded) {
  const match = /^pbkdf2-sha256\$(\d+)\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(encoded || '');
  const iterations = match ? Number(match[1]) : 100000;
  if (iterations < 1 || iterations > 100000) return false;
  const salt = Uint8Array.from((match?.[2] || '0'.repeat(32)).match(/../g), (v) => parseInt(v, 16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const hash = hex(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256),
  );
  const expected = match?.[3] || '0'.repeat(64);
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= hash.charCodeAt(i) ^ expected.charCodeAt(i);
  return !!match && diff === 0;
}
export function createAuth(pool) {
  return {
    async login(input) {
      if (
        typeof input?.username !== 'string' ||
        typeof input?.password !== 'string' ||
        input.username.length > 40 ||
        input.password.length > 128 ||
        !input.username.trim() ||
        !input.password
      )
        throw new ApiError(400, 'กรุณากรอก username และรหัสผ่าน');
      const username = input.username.trim().toLowerCase();
      const attemptKey = await digest(username);
      const attempt = (
        await pool.query(
          `INSERT INTO rally_login_attempts(key,attempts,reset_at) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN rally_login_attempts.reset_at<now() THEN 1 ELSE rally_login_attempts.attempts+1 END,reset_at=CASE WHEN rally_login_attempts.reset_at<now() THEN now()+interval '15 minutes' ELSE rally_login_attempts.reset_at END RETURNING attempts`,
          [attemptKey],
        )
      ).rows[0];
      if (attempt.attempts > 10)
        throw new ApiError(429, 'เข้าสู่ระบบไม่สำเร็จหลายครั้ง กรุณารอ 15 นาที');
      const player = (
        await pool.query(
          `SELECT p.*,r.name AS role_name FROM rally_players p JOIN rally_roles r ON r.id=p.role_id WHERE p.username=$1 AND p.kind='member'`,
          [username],
        )
      ).rows[0];
      const valid = await verifyPassword(input.password, player?.password_hash);
      if (!valid || player?.status !== 'active')
        throw new ApiError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง หรือบัญชีไม่พร้อมใช้งาน');
      const token = hex(crypto.getRandomValues(new Uint8Array(32)));
      // Check status/version again atomically after password verification.
      const inserted = await pool.query(
        `INSERT INTO rally_auth_sessions(token_hash,player_id,auth_version,expires_at) SELECT $1,id,auth_version,now()+interval '15 days' FROM rally_players WHERE id=$2 AND status='active' AND auth_version=$3 RETURNING player_id`,
        [await digest(token), player.id, player.auth_version],
      );
      if (!inserted.rowCount) throw new ApiError(401, 'บัญชีมีการเปลี่ยนแปลง กรุณาเข้าสู่ระบบใหม่');
      await pool.query('DELETE FROM rally_login_attempts WHERE key=$1 OR reset_at<now()', [
        attemptKey,
      ]);
      await pool.query('DELETE FROM rally_auth_sessions WHERE expires_at<now()');
      return {
        token,
        user: {
          id: player.id,
          name: player.name,
          username: player.username,
          avatar: player.avatar_url,
          role: player.role_name,
          status: player.status,
        },
      };
    },
    async current(request) {
      const token = cookieToken(request);
      if (!token) return null;
      return (
        (
          await pool.query(
            `UPDATE rally_auth_sessions s SET last_seen_at=now() FROM rally_players p JOIN rally_roles r ON r.id=p.role_id WHERE s.token_hash=$1 AND s.player_id=p.id AND s.auth_version=p.auth_version AND p.status='active' AND p.kind='member' AND s.expires_at>now() AND s.last_seen_at>now()-interval '15 days' RETURNING p.id,p.name,p.username,p.avatar_url AS avatar,r.name AS role,p.status,s.expires_at AS "_sessionExpiresAt"`,
            [await digest(token)],
          )
        ).rows[0] || null
      );
    },
    async logout(request) {
      const token = cookieToken(request);
      if (token)
        await pool.query('DELETE FROM rally_auth_sessions WHERE token_hash=$1', [
          await digest(token),
        ]);
    },
  };
}
