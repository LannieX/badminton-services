import { z } from 'zod';
import { ApiError } from './repository.mjs';

const inputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_.-]{3,40}$/),
    status: z.enum(['active', 'inactive']).optional(),
    avatar: z.string().max(200000).default(''),
    password: z.string().min(8).max(128).optional(),
  })
  .strict();
export const profileInput = inputSchema.pick({ name: true, username: true, avatar: true });
const columns =
  "id,name,CASE WHEN kind='guest' THEN '' ELSE username END AS username,(SELECT name FROM rally_roles WHERE id=role_id) AS role,avatar_url AS avatar,status,kind";

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const hash = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 },
    key,
    256,
  );
  const hex = (bytes) =>
    Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2-sha256$100000$${hex(salt)}$${hex(hash)}`;
}

export function createPlayerService(pool, env = {}, fetcher = fetch) {
  function config() {
    try {
      const url = new URL(env.CLOUDINARY_URL);
      if (
        url.protocol !== 'cloudinary:' ||
        !url.username ||
        !url.password ||
        !/^[a-z0-9_-]+$/i.test(url.hostname)
      )
        throw new Error();
      return {
        cloud: url.hostname,
        key: decodeURIComponent(url.username),
        secret: decodeURIComponent(url.password),
      };
    } catch {
      throw new ApiError(503, 'ยังไม่ได้ตั้งค่า Cloudinary สำหรับรูปผู้เล่น');
    }
  }
  async function cloudRequest(action, params, file) {
    const { cloud, key, secret } = config();
    params.timestamp = String(Math.floor(Date.now() / 1000));
    const text = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text + secret));
    const signature = Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    const form = new FormData();
    for (const [field, value] of Object.entries({ ...params, api_key: key, signature }))
      form.set(field, value);
    if (file) form.set('file', file);
    const response = await fetcher(`https://api.cloudinary.com/v1_1/${cloud}/image/${action}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(12000),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result)
      throw new ApiError(502, 'ติดต่อ Cloudinary ไม่สำเร็จ กรุณาลองอีกครั้ง');
    return result;
  }
  async function remove(publicId) {
    if (!publicId) return;
    try {
      await cloudRequest('destroy', { public_id: publicId });
    } catch {
      console.error('Player image cleanup failed');
    }
  }
  return {
    async createGuest(raw) {
      const parsed = z
        .object({ id: z.uuid(), name: z.string().trim().min(1).max(80) })
        .strict()
        .safeParse(raw);
      if (!parsed.success)
        throw new ApiError(400, 'กรุณากรอกชื่อผู้เล่นรับเชิญ ไม่เกิน 80 ตัวอักษร');
      const { id, name } = parsed.data;
      await pool.query(
        "INSERT INTO rally_players(id,name,username,role_id,kind,status) VALUES($1,$2,$3,2,'guest','active') ON CONFLICT(id) DO NOTHING",
        [id, name, 'guest_' + id.replaceAll('-', '')],
      );
      const saved = (await pool.query(`SELECT ${columns} FROM rally_players WHERE id=$1`, [id]))
        .rows[0];
      if (!saved || saved.kind !== 'guest' || saved.name !== name || saved.status !== 'active')
        throw new ApiError(409, 'รายชื่อนี้มีข้อมูลเปลี่ยนแปลง กรุณาเพิ่มชื่อใหม่อีกครั้ง');
      return saved;
    },
    async list(query = '') {
      if (query.length > 80) throw new ApiError(400, 'คำค้นหายาวเกินไป');
      // strpos treats % and _ as literal search text.
      return (
        await pool.query(
          `SELECT p.id,p.name,CASE WHEN p.kind='guest' THEN '' ELSE p.username END AS username,r.name AS role,p.avatar_url AS avatar,p.status,p.kind FROM rally_players p JOIN rally_roles r ON r.id=p.role_id WHERE strpos(lower(p.name || ' ' || p.username), lower($1)) > 0 ORDER BY p.created_at DESC,p.id`,
          [query.trim()],
        )
      ).rows;
    },
    async listPage(query = '', page = 1, pageSize = 10) {
      if (
        query.length > 80 ||
        !Number.isInteger(page) ||
        page < 1 ||
        page > 1000000 ||
        !Number.isInteger(pageSize) ||
        pageSize < 1 ||
        pageSize > 100
      )
        throw new ApiError(400, 'กรุณาเลือกหน้ารายการให้ถูกต้อง');
      const search = query.trim();
      const total = (
        await pool.query(
          "SELECT count(*)::integer AS total FROM rally_players WHERE kind='member' AND strpos(lower(name || ' ' || username),lower($1))>0",
          [search],
        )
      ).rows[0].total;
      const current = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
      const players = (
        await pool.query(
          `SELECT p.id,p.name,CASE WHEN p.kind='guest' THEN '' ELSE p.username END AS username,r.name AS role,p.avatar_url AS avatar,p.status,p.kind FROM rally_players p JOIN rally_roles r ON r.id=p.role_id WHERE p.kind='member' AND strpos(lower(p.name || ' ' || p.username),lower($1))>0 ORDER BY p.created_at DESC,p.id LIMIT $2 OFFSET $3`,
          [search, pageSize, (current - 1) * pageSize],
        )
      ).rows;
      return { players, total, page: current, pageSize };
    },
    async save(id, raw, actor) {
      const parsed = inputSchema.safeParse(raw);
      if (!parsed.success) {
        const passwordError = parsed.error.issues.find((issue) => issue.path[0] === 'password');
        throw new ApiError(
          400,
          passwordError
            ? 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร และไม่เกิน 128 ตัวอักษร'
            : 'กรุณาตรวจสอบชื่อและชื่อผู้ใช้ให้ถูกต้อง',
        );
      }
      const input = parsed.data;
      if (input.password && input.password.trim().length < 8)
        throw new ApiError(400, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
      const previous = id
        ? (
            await pool.query(
              'SELECT *, updated_at::text AS revision FROM rally_players WHERE id=$1',
              [id],
            )
          ).rows[0]
        : null;
      if (id && !previous) throw new ApiError(404, 'ไม่พบผู้เล่น');
      if (!id && !input.password) throw new ApiError(400, 'กรุณากรอกรหัสผ่าน');
      if (
        (
          await pool.query(
            'SELECT id FROM rally_players WHERE lower(username)=lower($1) AND ($2::uuid IS NULL OR id<>$2)',
            [input.username, id],
          )
        ).rowCount
      )
        throw new ApiError(409, 'Username นี้ถูกใช้งานแล้ว');
      if (id && input.status === 'inactive' && actor?.id === id)
        throw new ApiError(400, 'ไม่สามารถปิดใช้งานบัญชีตนเอง');
      let avatarUrl = previous?.avatar_url || '';
      let publicId = previous?.avatar_public_id || null;
      let uploaded = null;
      if (input.avatar !== avatarUrl) {
        if (!input.avatar) {
          avatarUrl = '';
          publicId = null;
        } else {
          if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(input.avatar))
            throw new ApiError(400, 'รูปภาพไม่ถูกต้อง');
          uploaded = await cloudRequest(
            'upload',
            { public_id: `ibadz/players/${crypto.randomUUID()}`, overwrite: 'false' },
            input.avatar,
          );
          const cloud = config().cloud;
          if (
            typeof uploaded.secure_url !== 'string' ||
            !uploaded.secure_url.startsWith(`https://res.cloudinary.com/${cloud}/image/upload/`) ||
            typeof uploaded.public_id !== 'string'
          )
            throw new ApiError(502, 'Cloudinary ส่งข้อมูลรูปภาพไม่ถูกต้อง');
          avatarUrl = uploaded.secure_url;
          publicId = uploaded.public_id;
        }
      }
      try {
        const hash = input.password
          ? await hashPassword(input.password)
          : previous?.password_hash || null;
        const db = await pool.connect();
        let saved;
        try {
          await db.query('BEGIN');
          await db.query('SELECT pg_advisory_xact_lock(72101343)');
          if (id && previous.role_id === 1 && input.status === 'inactive') {
            const count = (
              await db.query(
                "SELECT count(*)::integer AS count FROM rally_players WHERE role_id=1 AND status='active'",
              )
            ).rows[0].count;
            if (count <= 1) throw new ApiError(400, 'ต้องมี admin ที่ใช้งานได้อย่างน้อย 1 คน');
          }
          saved = id
            ? await db.query(
                `UPDATE rally_players SET name=$2,username=$3,role_id=$4,avatar_url=$5,avatar_public_id=$6,password_hash=$7,status=$9,auth_version=auth_version+CASE WHEN password_hash IS DISTINCT FROM $7 OR status IS DISTINCT FROM $9 THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1 AND updated_at=$8 RETURNING ${columns}`,
                [
                  id,
                  input.name,
                  input.username,
                  previous?.role_id ?? 2,
                  avatarUrl,
                  publicId,
                  hash,
                  previous.revision,
                  input.status ?? previous.status,
                ],
              )
            : await db.query(
                `INSERT INTO rally_players(id,name,username,role_id,avatar_url,avatar_public_id,password_hash,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${columns}`,
                [
                  crypto.randomUUID(),
                  input.name,
                  input.username,
                  previous?.role_id ?? 2,
                  avatarUrl,
                  publicId,
                  hash,
                  input.status ?? 'active',
                ],
              );
          if (!saved.rowCount)
            throw new ApiError(409, 'ข้อมูลผู้เล่นมีการเปลี่ยนแปลง กรุณาค้นหาใหม่ก่อนแก้ไข');
          await db.query('COMMIT');
        } catch (error) {
          await db.query('ROLLBACK');
          throw error;
        } finally {
          db.release();
        }
        if (previous?.avatar_public_id && previous.avatar_public_id !== publicId)
          await remove(previous.avatar_public_id);
        return saved.rows[0];
      } catch (error) {
        if (uploaded) await remove(uploaded.public_id);
        if (error.code === '23505') throw new ApiError(409, 'Username นี้ถูกใช้งานแล้ว');
        throw error;
      }
    },
    async delete(id) {
      const result = await pool.query(
        'DELETE FROM rally_players WHERE id=$1 RETURNING avatar_public_id',
        [id],
      );
      if (!result.rowCount) throw new ApiError(404, 'ไม่พบผู้เล่น');
      await remove(result.rows[0].avatar_public_id);
    },
  };
}
