/**
 * 登录注册与会话管理（session token 存库，httpOnly cookie）。
 */
import { randomBytes } from 'node:crypto';
import { query, hashPassword, verifyPassword, isLegacyHash } from './db.js';

const SESSION_TTL_DAYS = 30;
const COOKIE_NAME = 'cl_sid';

function newToken() {
  return randomBytes(32).toString('hex');
}

export function sessionCookie(token, expiresAt) {
  const exp = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  // httpOnly + SameSite=Lax；非 https 部署时仍可用（未加 Secure）
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${exp}; HttpOnly; SameSite=Lax`;
}

function parseCookies(req) {
  const h = req.headers.cookie || '';
  const out = {};
  h.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

/** 取当前登录用户（无则 null），顺带清理过期 session。 */
export async function getUserFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const res = await query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token]
  );
  if (res.rowCount === 0) return null;
  const u = res.rows[0];
  return sanitizeUser(u);
}

function sanitizeUser(u) {
  return {
    id: u.id, username: u.username, nickname: u.nickname, email: u.email,
    gender: u.gender, birth_calendar: u.birth_calendar, birth_date: u.birth_date,
    birth_time: u.birth_time, birth_location: u.birth_location, day_master: u.day_master,
    // 5.3：四元运势所需（日主天干 + 月令地支）
    day_stem: u.day_stem, month_zhi: u.month_zhi,
    weather_city: u.weather_city, created_at: u.created_at,
  };
}

export async function register({ username, password, nickname, email, consent }) {
  if (!username || !password) throw new Error('用户名与密码必填');
  if (String(password).length < 6) throw new Error('密码至少 6 位');
  const exists = await query('SELECT 1 FROM users WHERE username = $1', [username]);
  if (exists.rowCount) throw new Error('该用户名已被注册');
  const hash = hashPassword(password);
  const res = await query(
    `INSERT INTO users (username, password, nickname, email)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [username, hash, nickname || username, email || null]
  );
  const u = res.rows[0];
  // R2† · 明示同意：注册即记录（用户协议 / 隐私政策），非默认勾选由前端保证
  if (consent) {
    await query(`INSERT INTO user_agreements (user_id, type, version) VALUES ($1,'terms','6.3.0')`, [u.id]).catch(() => {});
    await query(`INSERT INTO user_agreements (user_id, type, version) VALUES ($1,'privacy','6.3.0')`, [u.id]).catch(() => {});
  }
  return sanitizeUser(u);
}

export async function login({ username, password }) {
  if (!username || !password) throw new Error('用户名与密码必填');
  const res = await query('SELECT * FROM users WHERE username = $1', [username]);
  if (res.rowCount === 0) throw new Error('用户不存在');
  const u = res.rows[0];
  if (!verifyPassword(password, u.password)) {
    // R0：旧版伪同步哈希（派生值全零）必然校验失败 → 提示重置，强制全量密码重置
    if (isLegacyHash(u.password)) throw new Error('密码已过期，请前往「找回密码」重置后再登录');
    throw new Error('密码错误');
  }
  return sanitizeUser(u);
}

// ── 密码重置通道（R0 · 认证修复后强制全量重置）──
const RESET_TTL_HOURS = 24;

/**
 * 申请重置：按用户名生成重置 token 并入库。
 * 返回 token（自托管/无 SMTP 时回传前端）；生产环境应通过邮件下发。
 * 用户不存在时返回 null（调用方统一返回 ok:true，避免账号枚举）。
 */
export async function requestPasswordReset(username) {
  const res = await query('SELECT id FROM users WHERE username = $1', [username]);
  if (res.rowCount === 0) return null;
  const userId = res.rows[0].id;
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + RESET_TTL_HOURS * 3600000);
  await query(
    `INSERT INTO password_resets (token, user_id, expires_at) VALUES ($1,$2,$3)`,
    [token, userId, expiresAt]
  );
  return token;
}

/**
 * 确认重置：校验 token（存在/未用/未过期）后写入新密码哈希，并标记 token 已用。
 */
export async function confirmPasswordReset(token, password) {
  if (!token || !password) throw new Error('参数缺失');
  if (String(password).length < 6) throw new Error('密码至少 6 位');
  const res = await query(
    `SELECT user_id FROM password_resets WHERE token=$1 AND used_at IS NULL AND expires_at > now()`,
    [token]
  );
  if (res.rowCount === 0) throw new Error('重置链接无效或已过期');
  const userId = res.rows[0].user_id;
  const hash = hashPassword(password);
  await query('UPDATE users SET password=$1, updated_at=now() WHERE id=$2', [hash, userId]);
  await query('UPDATE password_resets SET used_at=now() WHERE token=$1', [token]);
  return true;
}

export async function createSession(userId) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400000);
  await query(
    `INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)`,
    [token, userId, expiresAt]
  );
  return { token, expiresAt };
}

export async function destroySession(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (token) await query('DELETE FROM sessions WHERE token = $1', [token]).catch(() => {});
}

/** 更新用户资料（出生信息 / 昵称 / 天气城市等）。 */
export async function updateProfile(userId, patch) {
  const allowed = ['nickname', 'email', 'gender', 'birth_calendar', 'birth_date', 'birth_time', 'birth_location', 'day_master', 'day_stem', 'month_zhi', 'weather_city'];
  const sets = [];
  const params = [];
  let i = 1;
  for (const k of allowed) {
    if (k in patch) { sets.push(`${k} = $${i}`); params.push(patch[k]); i++; }
  }
  if (!sets.length) return;
  params.push(userId);
  await query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${i}`, params);
}

// ── 游客匿名会话（5.1 免登录试用）──
export const ANON_COOKIE_NAME = 'cl_aid';
const ANON_TTL_DAYS = 7;

function newAnonId() { return randomBytes(24).toString('hex'); }

function anonCookie(anonId, expiresAt) {
  const exp = Math.floor((expiresAt.getTime() - Date.now()) / 1000);
  return `${ANON_COOKIE_NAME}=${anonId}; Path=/; Max-Age=${exp}; HttpOnly; SameSite=Lax`;
}

/** 取游客匿名 ID；无则生成并写入 Set-Cookie（res 存在时）。 */
export function getAnonId(req, res) {
  const cookies = parseCookies(req);
  const existing = cookies[ANON_COOKIE_NAME];
  if (existing) return existing;
  const anonId = newAnonId();
  if (res) {
    const expiresAt = new Date(Date.now() + ANON_TTL_DAYS * 86400000);
    res.setHeader('Set-Cookie', anonCookie(anonId, expiresAt));
  }
  return anonId;
}

/** 登录用户优先；否则游客（自动颁发匿名 cookie）。返回 { user, anonId, isGuest }。 */
export async function requireUserOrAnon(req, res) {
  const user = await getUserFromRequest(req);
  if (user) return { user, anonId: null, isGuest: false };
  const anonId = getAnonId(req, res);
  return { user: null, anonId, isGuest: true };
}

/** 注册后把游客匿名命盘并入账号（user_id 置为注册用户，anon_id 清空）。 */
export async function mergeAnonCharts(anonId, userId) {
  if (!anonId) return 0;
  const r = await query(
    `UPDATE charts SET user_id=$1, anon_id=NULL WHERE anon_id=$2 AND user_id IS NULL`,
    [userId, anonId]
  );
  // R2† · 记录匿名↔用户映射，供一键删除按双条件覆盖游客侧六表
  await query(
    `INSERT INTO user_anon_link (user_id, anon_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [userId, anonId]
  ).catch(() => {});
  return r.rowCount || 0;
}

/** 注册后把游客匿名对话会话并入账号（与 mergeAnonCharts 对称，5.2）。 */
export async function mergeAnonConversations(anonId, userId) {
  if (!anonId) return 0;
  const r = await query(
    `UPDATE conversations SET user_id=$1, anon_id=NULL WHERE anon_id=$2 AND user_id IS NULL`,
    [userId, anonId]
  );
  return r.rowCount || 0;
}
