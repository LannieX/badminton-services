import { z } from 'zod';
import { hashPassword } from './players.mjs';
import { ApiError } from './repository.mjs';
const inputSchema = z
  .object({
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_.-]{3,40}$/),
    password: z.string().min(8).max(128),
    confirmPassword: z.string().min(8).max(128),
  })
  .strict();
export async function resetPassword(pool, actor, raw, sessionHash) {
  const result = inputSchema.safeParse(raw);
  if (!result.success)
    throw new ApiError(400, 'กรุณากรอก username และรหัสผ่านอย่างน้อย 8 ตัวอักษร');
  const input = result.data;
  if (input.password.trim().length < 8)
    throw new ApiError(400, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
  if (input.password !== input.confirmPassword)
    throw new ApiError(400, 'รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน');
  if (actor.role !== 'admin' && input.username !== actor.username)
    throw new ApiError(403, 'เปลี่ยนรหัสผ่านได้เฉพาะบัญชีของคุณ');
  const hash = await hashPassword(input.password);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const player = (
      await db.query(
        "SELECT id FROM rally_players WHERE username=$1 AND kind='member' FOR UPDATE",
        [input.username],
      )
    ).rows[0];
    if (!player) throw new ApiError(404, 'ไม่พบชื่อผู้ใช้นี้');
    if (actor.role !== 'admin' && player.id !== actor.id)
      throw new ApiError(403, 'เปลี่ยนรหัสผ่านได้เฉพาะบัญชีของคุณ');
    const keep = player.id === actor.id ? sessionHash : null;
    await db.query(
      'UPDATE rally_players SET password_hash=$2,auth_version=auth_version+1,updated_at=now() WHERE id=$1',
      [player.id, hash],
    );
    await db.query(
      'DELETE FROM rally_auth_sessions WHERE player_id=$1 AND ($2::text IS NULL OR token_hash<>$2)',
      [player.id, keep],
    );
    if (keep)
      await db.query(
        'UPDATE rally_auth_sessions s SET auth_version=p.auth_version FROM rally_players p WHERE s.player_id=p.id AND p.id=$1 AND s.token_hash=$2',
        [player.id, keep],
      );
    await db.query('COMMIT');
    return { ok: true };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
