import { ApiError } from './repository.mjs';
export async function syncPaymentMembers(db, id, input) {
  const old = (
    await db.query(
      'SELECT player_id,amount_cents FROM rally_payment_members WHERE payment_id=$1 ORDER BY position',
      [id],
    )
  ).rows;
  const ids = input.memberIds ?? (old.length ? old.map((row) => row.player_id) : []);
  if (!ids.length) return;
  if (ids.length !== input.playerCount || new Set(ids).size !== ids.length)
    throw new ApiError(400, 'กรุณาเลือกสมาชิกให้ตรงจำนวนผู้เล่น');
  const existing = new Set(old.map((row) => row.player_id));
  const players = (
    await db.query(
      'SELECT id,status FROM rally_players WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
      [ids],
    )
  ).rows;
  if (
    players.length !== ids.length ||
    players.some((p) => p.status !== 'active' && !existing.has(p.id))
  )
    throw new ApiError(400, 'สมาชิกที่เลือกไม่พร้อมใช้งาน กรุณาเลือกสมาชิก active');
  const base = Math.floor(input.totalCents / ids.length),
    extra = input.totalCents % ids.length;
  const allocations = ids.map((playerId, i) => ({ playerId, amount: base + (i < extra ? 1 : 0) }));
  const unchanged =
    old.length === ids.length &&
    allocations.every((a) =>
      old.some((row) => row.player_id === a.playerId && row.amount_cents === a.amount),
    );
  await db.query(
    'DELETE FROM rally_payment_members WHERE payment_id=$1 AND NOT(player_id=ANY($2::uuid[]))',
    [id, ids],
  );
  for (const [position, a] of allocations.entries())
    await db.query(
      `INSERT INTO rally_payment_members(payment_id,player_id,position,amount_cents) VALUES($1,$2,$3,$4) ON CONFLICT(payment_id,player_id) DO UPDATE SET position=excluded.position,amount_cents=excluded.amount_cents,paid_at=CASE WHEN $5 THEN rally_payment_members.paid_at ELSE NULL END,confirmed_by=CASE WHEN $5 THEN rally_payment_members.confirmed_by ELSE NULL END`,
      [id, a.playerId, position, a.amount, unchanged],
    );
}
export async function samePaymentMembers(db, id, input) {
  if (!input.memberIds) return true;
  const current = (
    await db.query(
      'SELECT player_id FROM rally_payment_members WHERE payment_id=$1 ORDER BY position',
      [id],
    )
  ).rows;
  return (
    current.length === input.memberIds.length &&
    current.every((row, i) => row.player_id === input.memberIds[i])
  );
}

export async function assertPaymentManager(pool, actor, id, ownerOnly = false) {
  if (!ownerOnly && actor.role === 'admin') return;
  const payment = (
    await pool.query('SELECT created_by FROM rally_payment_requests WHERE id=$1', [id])
  ).rows[0];
  if (!payment || payment.created_by !== actor.id)
    throw new ApiError(
      403,
      ownerOnly
        ? 'ลบได้เฉพาะรายการที่คุณเป็นผู้เรียกเก็บ'
        : 'เฉพาะผู้เรียกเก็บหรือผู้ดูแลที่จัดการรายการนี้ได้',
    );
}
