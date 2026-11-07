import banks from './banks.json' with { type: 'json' };
import { z } from 'zod';
const name = (max) => z.string().trim().min(1).max(max);
export const sessionInput = z.object({ id: z.uuid(), name: name(80), date: z.iso.date() }).strict();
const historicalMatch = z
  .object({
    id: z.uuid(),
    time: z.iso.datetime({ offset: true }),
    mode: z.enum(['single', 'double']),
    names: z.tuple([name(60), name(60)]),
    scores: z.tuple([z.number().int().min(0).max(10000), z.number().int().min(0).max(10000)]),
    target: z.number().int().min(1).max(999),
  })
  .strict()
  .refine((m) => m.scores[0] !== m.scores[1] && Math.max(...m.scores) >= m.target, {
    message: 'เกมยังไม่ถึงคะแนนเป้าหมายหรือคะแนนเสมอ',
  });
export const matchInput = historicalMatch.refine(
  (m) => Math.abs(Date.now() - Date.parse(m.time)) < 86400000,
  {
    message: 'เวลาจบเกมไม่ถูกต้อง',
  },
);
const expense = z
  .object({
    id: z.uuid(),
    title: name(80),
    amount: z
      .number()
      .finite()
      .min(0.01)
      .max(9999999)
      .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.000001, {
        message: 'จำนวนเงินต้องมีทศนิยมไม่เกิน 2 ตำแหน่ง',
      }),
  })
  .strict();
const member = z.object({ id: z.uuid(), name: name(60), paid: z.boolean() }).strict();
export const updateInput = z
  .object({
    version: z.number().int().min(1),
    expenses: z.array(expense).max(500),
    members: z.array(member).max(500),
  })
  .strict()
  .refine(
    (s) =>
      new Set(s.expenses.map((e) => e.id)).size === s.expenses.length &&
      new Set(s.members.map((m) => m.id)).size === s.members.length,
    { message: 'มีรหัสรายการซ้ำ' },
  );

export const importInput = z
  .object({
    sessions: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          name: name(80),
          date: z.iso.date(),
          matches: z.array(historicalMatch).max(1000),
          expenses: z.array(expense).max(500),
          members: z.array(member).max(500),
        }),
      )
      .min(1)
      .max(100),
  })
  .strict();

const bankCodes = banks.map((bank) => bank.code);
function validPromptPay(value) {
  if (/^0[689]\d{8}$/.test(value)) return true;
  if (!/^\d{13}$/.test(value)) return false;
  const sum = [...value.slice(0, 12)].reduce((n, d, i) => n + Number(d) * (13 - i), 0);
  return (11 - (sum % 11)) % 10 === Number(value[12]);
}
export const paymentInput = z
  .object({
    id: z.uuid(),
    sessionId: z.string().min(1).max(100).optional(),
    totalCents: z.number().int().min(1).max(999999900),
    playerCount: z.number().int().min(1).max(500),
    method: z.enum(['promptpay', 'bank']),
    recipient: z.string().regex(/^\d{10,15}$/),
    bankCode: z.string().optional(),
  })
  .strict()
  .refine((input) => input.totalCents >= input.playerCount, {
    message: 'ยอดต่อคนต้องไม่น้อยกว่า 0.01 บาท',
  })
  .refine(
    (input) =>
      input.method === 'promptpay'
        ? validPromptPay(input.recipient) && input.bankCode === undefined
        : bankCodes.includes(input.bankCode) && /^\d{10,15}$/.test(input.recipient),
    { message: 'ข้อมูลรับเงินไม่ถูกต้อง' },
  );

export const paymentVersionInput = z.object({ version: z.number().int().min(1) }).strict();
export const paymentEditInput = z
  .object({ version: z.number().int().min(1), payment: paymentInput })
  .strict();
export const paymentIdInput = z.uuid();
