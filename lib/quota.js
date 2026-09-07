/**
 * 辰箓 Chronik · I3 服务端权威配额（P0-6）
 *
 * 统一入口 checkAiQuota(ctx)：
 *   - 游客（guest）    → anon_chat_rate 原子 UPSERT（Asia/Shanghai 自然日，3 轮/日）
 *   - 注册用户（user） → 先 hasActiveEntitlement 定 limit（有效 30 / 否则 3）
 *                        → user_ai_quota 原子 UPSERT
 * 返回 { ok, remaining, limit, isPaid, paywall }。
 *
 * 集中常量（运营改一处即可生效）：
 *   FREE_DAILY_ROUNDS  = 3  免费用户 / 游客 每日 AI 轮次（D4 拍板）
 *   PAID_DAILY_ROUNDS  = 30 付费用户 每日 AI 轮次（Edward 拍板）
 *
 * fail-open：任何 DB 异常 → 返回 {ok:true, remaining:FREE, isPaid:false}（放行，绝不 500/拦截）。
 * 仅「兑换码原子核销」与「内容禁区」属明确安全硬拦截（见 server.js handleRedeem / isBlocked）。
 *
 * 依赖：lib/db.js 的 query()（pg 连接池）。
 */

import { query } from './db.js';

// ── 集中常量（运营改此处即可）──
export const FREE_DAILY_ROUNDS = 3;
export const PAID_DAILY_ROUNDS = 30;

/**
 * 查询用户当前有效付费授权。
 * @param {string|number} userId
 * @returns {Promise<{plan:string, expiresAt:Date}|null>}
 *   null = 无有效授权（免费态）。异常 → null（fail-open，绝不让用户看到 500）。
 */
export async function getEntitlement(userId) {
  try {
    const r = await query(
      `SELECT plan, expires_at FROM entitlement_grants
       WHERE grantee_type = 'user_id' AND grantee_id = $1 AND expires_at > now()
       ORDER BY expires_at DESC LIMIT 1`,
      [String(userId)],
    );
    if (r.rowCount === 0) return null;
    return { plan: r.rows[0].plan, expiresAt: r.rows[0].expires_at };
  } catch (e) {
    console.error('[entitlement] 查询异常，fail-open 视为无授权：', e.message);
    return null;
  }
}

/** 是否有有效付费授权（fail-open）。 */
export async function hasActiveEntitlement(userId) {
  const ent = await getEntitlement(userId);
  return !!ent;
}

/**
 * 读取当前剩余额度（不递增计数），供 GET /api/quota 使用。
 * 纯 PG 侧自然日比较，禁止 Node/前端本地时区算日期（共享约定 §6.1）。
 */
export async function getQuotaInfo(ctx) {
  try {
    const isGuest = ctx.isGuest;
    const key = isGuest ? ctx.anonId : ctx.user.id;
    const keyCol = isGuest ? 'anon_id' : 'user_id';
    const table = isGuest ? 'anon_chat_rate' : 'user_ai_quota';
    const hasEnt = !isGuest && (await hasActiveEntitlement(ctx.user.id));
    const limit = hasEnt ? PAID_DAILY_ROUNDS : FREE_DAILY_ROUNDS;
    const r = await query(
      `SELECT rounds FROM ${table}
       WHERE ${keyCol} = $1 AND day_date = timezone('Asia/Shanghai', now())::date`,
      [isGuest ? key : String(key)],
    );
    const rounds = r.rowCount ? Number(r.rows[0].rounds) : 0;
    return {
      remaining: Math.max(0, limit - rounds),
      limit,
      isPaid: hasEnt,
      plan: hasEnt ? 'paid' : 'free',
    };
  } catch (e) {
    console.error('[quota] 读取异常，fail-open 放行：', e.message);
    return { remaining: FREE_DAILY_ROUNDS, limit: FREE_DAILY_ROUNDS, isPaid: false, plan: 'free' };
  }
}

/**
 * 统一配额入口：原子 UPSERT 递增当日计数，跨日自动归 1。
 * @param {object} ctx requireUserOrAnon 返回的上下文 { user, anonId, isGuest }
 * @returns {Promise<{ok:boolean, remaining:number, limit:number, isPaid:boolean, paywall:boolean}>}
 */
export async function checkAiQuota(ctx) {
  try {
    const isGuest = ctx.isGuest;
    const key = isGuest ? ctx.anonId : ctx.user.id;
    const keyCol = isGuest ? 'anon_id' : 'user_id';
    const table = isGuest ? 'anon_chat_rate' : 'user_ai_quota';
    const hasEnt = !isGuest && (await hasActiveEntitlement(ctx.user.id));
    const limit = hasEnt ? PAID_DAILY_ROUNDS : FREE_DAILY_ROUNDS;

    // 原子 UPSERT：单语句完成「判日 + 计次」，无竞态、无 Redis（共享约定 §6.2）
    const r = await query(
      `INSERT INTO ${table} (${keyCol}, rounds, day_date)
       VALUES ($1, 1, timezone('Asia/Shanghai', now())::date)
       ON CONFLICT (${keyCol}) DO UPDATE
         SET rounds = CASE
               WHEN ${table}.day_date IS DISTINCT FROM excluded.day_date THEN 1
               ELSE ${table}.rounds + 1 END,
             day_date = excluded.day_date
       RETURNING rounds`,
      [isGuest ? key : String(key)],
    );
    const rounds = Number(r.rows[0].rounds);
    const remaining = Math.max(0, limit - rounds);
    if (rounds > limit) {
      // 已超额度 → 拦截（remaining 保持 0，不继续递增）
      return { ok: false, remaining, limit, isPaid: hasEnt, paywall: true };
    }
    return { ok: true, remaining, limit, isPaid: hasEnt, paywall: false };
  } catch (e) {
    console.error('[quota] 计量异常，fail-open 放行：', e.message);
    return { ok: true, remaining: FREE_DAILY_ROUNDS, limit: FREE_DAILY_ROUNDS, isPaid: false, paywall: false };
  }
}
