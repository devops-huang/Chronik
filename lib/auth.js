/**
 * 登录注册与会话管理（session token 存库，httpOnly cookie）。
 */
import { randomBytes } from 'node:crypto';
import { query, hashPassword, verifyPassword } from './db.js';

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
    weather_city: u.weather_city, created_at: u.created_at,
  };
}

export async function register({ username, password, nickname, email }) {
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
  return sanitizeUser(res.rows[0]);
}

export async function login({ username, password }) {
  if (!username || !password) throw new Error('用户名与密码必填');
  const res = await query('SELECT * FROM users WHERE username = $1', [username]);
  if (res.rowCount === 0) throw new Error('用户不存在');
  const u = res.rows[0];
  if (!verifyPassword(password, u.password)) throw new Error('密码错误');
  return sanitizeUser(u);
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
  const allowed = ['nickname', 'email', 'gender', 'birth_calendar', 'birth_date', 'birth_time', 'birth_location', 'day_master', 'weather_city'];
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
